//! Native ownership of the shared 198-item / 99-palette backpack contract.
use crate::protocol::{self, backpack as wire, inventory as pb};
use anyhow::{Context, Result, ensure};
use pb::inventory_resource::Content;
use prost::Message;
use serde::{Deserialize, Serialize};

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Category {
    #[default]
    Items,
    Colors,
}
impl Category {
    pub fn capacity(self) -> usize {
        if self == Self::Items { 198 } else { 99 }
    }
    pub fn name(self) -> &'static str {
        if self == Self::Items {
            "Items"
        } else {
            "Color sets"
        }
    }
}
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Backpack {
    pub data: wire::Backpack,
}
impl Backpack {
    pub fn from_legacy(resources: Vec<pb::InventoryResource>) -> Result<Self> {
        let mut out = Self::default();
        for resource in resources {
            out.insert(resource)?;
        }
        Ok(out)
    }
    pub fn active(&self) -> Category {
        if self.data.active_view == 1 {
            Category::Colors
        } else {
            Category::Items
        }
    }
    pub fn set_active(&mut self, category: Category) {
        self.data.active_view = i32::from(category == Category::Colors);
    }
    pub fn group(&self, category: Category) -> Option<&wire::InventoryGroup> {
        if category == Category::Items {
            self.data.items.as_ref()
        } else {
            self.data.color_sets.as_ref()
        }
    }
    fn group_mut(&mut self, category: Category) -> &mut wire::InventoryGroup {
        if category == Category::Items {
            &mut self.data.items
        } else {
            &mut self.data.color_sets
        }
        .get_or_insert_default()
    }
    pub fn get(&self, category: Category, slot: usize) -> Option<&pb::InventoryResource> {
        self.group(category)?.slots.get(slot)?.resource.as_ref()
    }
    pub fn selected(&self, category: Category) -> usize {
        self.group(category).map_or(0, |g| g.selected as usize)
    }
    pub fn select(&mut self, category: Category, slot: usize) -> Result<()> {
        ensure!(slot < category.capacity(), "Backpack slot is out of range");
        self.group_mut(category).selected = slot as u32;
        self.set_active(category);
        Ok(())
    }
    pub fn replace(
        &mut self,
        category: Category,
        slot: usize,
        resource: Option<pb::InventoryResource>,
    ) -> Result<Option<pb::InventoryResource>> {
        ensure!(slot < category.capacity(), "Backpack slot is out of range");
        if let Some(r) = &resource {
            protocol::validate(r)?;
            ensure!(
                category_of(r) == category,
                "Resource belongs to a different backpack category"
            );
        }
        let group = self.group_mut(category);
        group
            .slots
            .resize_with(group.slots.len().max(slot + 1), Default::default);
        let previous = std::mem::replace(&mut group.slots[slot].resource, resource);
        while group.slots.last().is_some_and(|s| s.resource.is_none()) {
            group.slots.pop();
        }
        Ok(previous)
    }
    pub fn insert(&mut self, resource: pb::InventoryResource) -> Result<usize> {
        protocol::validate(&resource)?;
        let category = category_of(&resource);
        let slot = (0..category.capacity())
            .find(|&i| self.get(category, i).is_none())
            .context("Backpack is full")?;
        self.replace(category, slot, Some(wrap_resource(resource)))?;
        self.select(category, slot)?;
        Ok(slot)
    }
    pub fn swap(&mut self, category: Category, a: usize, b: usize) -> Result<()> {
        ensure!(
            a < category.capacity() && b < category.capacity(),
            "Backpack slot is out of range"
        );
        let group = self.group_mut(category);
        group
            .slots
            .resize_with(group.slots.len().max(a.max(b) + 1), Default::default);
        group.slots.swap(a, b);
        if group.selected as usize == a {
            group.selected = b as u32;
        } else if group.selected as usize == b {
            group.selected = a as u32;
        }
        while group.slots.last().is_some_and(|s| s.resource.is_none()) {
            group.slots.pop();
        }
        Ok(())
    }
    pub fn rename(&mut self, category: Category, slot: usize, name: &str) -> Result<()> {
        let resource = self
            .group_mut(category)
            .slots
            .get_mut(slot)
            .and_then(|s| s.resource.as_mut())
            .context("Backpack slot is empty")?;
        set_name(resource, name);
        Ok(())
    }
    pub fn iter(&self) -> impl Iterator<Item = &pb::InventoryResource> {
        self.data
            .items
            .iter()
            .chain(self.data.color_sets.iter())
            .flat_map(|g| g.slots.iter())
            .filter_map(|s| s.resource.as_ref())
    }
    pub fn is_empty(&self) -> bool {
        self.iter().next().is_none()
    }
    pub fn legacy_resources(&self) -> Vec<pb::InventoryResource> {
        self.iter().cloned().collect()
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut data = self.data.clone();
        data.schema_version = 10;
        Ok(data.encode_to_vec())
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() <= 64 * 1024 * 1024, "Backpack exceeds 64 MiB");
        let current = wire::Backpack::decode(bytes)?;
        let out = if current.schema_version == 10 {
            Self { data: current }
        } else {
            let old = wire::LegacyBackpack::decode(bytes)?;
            ensure!(
                [8, 9].contains(&old.schema_version),
                "Unsupported backpack version"
            );
            let mut data = wire::Backpack {
                schema_version: 10,
                color_sets: old.color_sets,
                active_view: i32::from(old.active_category == 2),
                ..Default::default()
            };
            let blocks = old.block_sets.unwrap_or_default();
            let entities = old.entities.unwrap_or_default();
            ensure!(
                blocks.slots.len() <= 99 && entities.slots.len() <= 99,
                "Legacy slots exceed capacity"
            );
            let (priority, other) = if old.active_category == 1 {
                (&entities, &blocks)
            } else {
                (&blocks, &entities)
            };
            ensure!(
                priority.selected < 99 && other.selected < 99,
                "Invalid legacy selection"
            );
            let mut items = wire::InventoryGroup {
                selected: if priority.selected < 9 {
                    priority.selected
                } else {
                    18 + priority.selected - 9
                },
                slots: Vec::new(),
            };
            for (group, range) in [
                (priority, 0..9),
                (other, 0..9),
                (priority, 9..99),
                (other, 9..99),
            ] {
                for index in range {
                    items
                        .slots
                        .push(group.slots.get(index).cloned().unwrap_or_default());
                }
            }
            while items
                .slots
                .last()
                .is_some_and(|slot| slot.resource.is_none())
            {
                items.slots.pop();
            }
            for slot in &mut items.slots {
                if let Some(resource) = slot.resource.take() {
                    slot.resource = Some(wrap_resource(resource));
                }
            }
            data.items = Some(items);
            Self { data }
        };
        out.validate()?;
        Ok(out)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            [0, 1].contains(&self.data.active_view),
            "Invalid backpack view"
        );
        for category in [Category::Items, Category::Colors] {
            if let Some(group) = self.group(category) {
                ensure!(
                    group.slots.len() <= category.capacity()
                        && (group.selected as usize) < category.capacity(),
                    "Backpack capacity exceeded"
                );
                for slot in &group.slots {
                    if let Some(r) = &slot.resource {
                        protocol::validate(r)?;
                        ensure!(category_of(r) == category, "Invalid backpack category");
                    }
                }
            }
        }
        Ok(())
    }
}
pub fn category_of(r: &pb::InventoryResource) -> Category {
    if matches!(&r.content, Some(Content::ColorSet(_))) {
        Category::Colors
    } else {
        Category::Items
    }
}
pub fn name(r: &pb::InventoryResource) -> String {
    match &r.content {
        Some(Content::BlockSet(v)) => v.name.clone(),
        Some(Content::Entity(v)) => v
            .root
            .as_ref()
            .map_or_else(|| "Entity".into(), |c| c.name.clone()),
        Some(Content::Item(v)) => v.name.clone(),
        Some(Content::ColorSet(v)) => v.name.clone(),
        None => "Empty".into(),
    }
}
pub fn set_name(r: &mut pb::InventoryResource, value: &str) {
    let name: String = value.trim().chars().take(80).collect();
    match &mut r.content {
        Some(Content::BlockSet(v)) => v.name = name,
        Some(Content::Entity(v)) => {
            if let Some(root) = &mut v.root {
                root.name = name;
            }
        }
        Some(Content::Item(v)) => v.name = name,
        Some(Content::ColorSet(v)) => v.name = name,
        None => {}
    }
}
pub fn wrap_resource(mut r: pb::InventoryResource) -> pb::InventoryResource {
    // A legacy absolute world anchor has no source pose here. Keep its original
    // standalone representation instead of silently changing that anchor.
    if matches!(&r.content, Some(Content::Entity(e)) if e.constraints.iter().any(|c| c.body_a_component_id.is_none()))
    {
        return r;
    }
    let name = name(&r);
    let content = match r.content.take() {
        Some(Content::BlockSet(block_set)) => Content::Item(pb::Item {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            block_set: Some(block_set),
            entity_list: Vec::new(),
        }),
        Some(Content::Entity(entity)) => Content::Item(pb::Item {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            block_set: None,
            entity_list: vec![entity],
        }),
        other => {
            r.content = other;
            return r;
        }
    };
    r.content = Some(content);
    r
}
