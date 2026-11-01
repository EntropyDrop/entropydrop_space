//! Conservative far-face block rejection, before vertex processing.
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3, Vec4};

pub const BLOCK_FACES: usize = 16;
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct VisibilityBlock {
    pub sphere: [f32; 4],
    pub cone: [f32; 4],
    pub flat: [f32; 4],
}

/// Prefix sums make coverage checks independent of a block's rectangle area.
/// Both dimensions wrap at the same seam as the fragment ownership mask.
pub struct Coverage {
    sums: Vec<u32>,
    pub revision: u64,
}
impl Default for Coverage {
    fn default() -> Self {
        Self {
            sums: vec![0; 1025 * 129],
            revision: 0,
        }
    }
}
impl Coverage {
    pub fn update(&mut self, bytes: &[u8]) {
        assert_eq!(bytes.len(), 1024 * 128 * 2);
        self.revision += 1;
        for z in 0..128 {
            let mut row = 0;
            for x in 0..1024 {
                let at = (z * 1024 + x) * 2;
                row += u32::from(bytes[at] == 255 || bytes[at + 1] > 127);
                self.sums[(z + 1) * 1025 + x + 1] = self.sums[z * 1025 + x + 1] + row;
            }
        }
    }
    pub fn covers(&self, bounds: [f32; 4]) -> bool {
        let ranges = |min: f32, max: f32, period: i32| {
            let lo = ((min - 0.02) / 16.0).floor() as i32;
            let hi = ((max + 0.02) / 16.0).floor() as i32;
            let count = (hi - lo + 1).clamp(0, period);
            let start = lo.rem_euclid(period);
            [
                (start as usize, (start + count).min(period) as usize),
                (0, (start + count - period).max(0) as usize),
            ]
        };
        for (x0, x1) in ranges(bounds[0], bounds[1], 1024) {
            for (z0, z1) in ranges(bounds[2], bounds[3], 128) {
                let count = self.sums[z1 * 1025 + x1] + self.sums[z0 * 1025 + x0]
                    - self.sums[z0 * 1025 + x1]
                    - self.sums[z1 * 1025 + x0];
                if count as usize != (x1 - x0) * (z1 - z0) {
                    return false;
                }
            }
        }
        true
    }
}

#[derive(Clone, Copy)]
pub struct CullView {
    planes: [Vec4; 6],
    eye: Vec3,
    torus: bool,
    backfaces: bool,
}

/// Ordered hierarchy: accepting a node appends its original range, so alpha
/// and tie-breaking order never change. All bounds include the leaf padding.
#[derive(Default)]
pub struct VisibilityTree {
    nodes: Vec<Node>,
}
struct Node {
    center: Vec3,
    radius: f32,
    axis: Vec3,
    axis_deviation: f32,
    cone_deviation: f32,
    normal_length: f32,
    deviation: f32,
    start: usize,
    end: usize,
    right: usize,
}
impl VisibilityTree {
    pub fn new(blocks: &[VisibilityBlock]) -> Self {
        let mut tree = Self::default();
        if !blocks.is_empty() {
            tree.build(blocks, 0, blocks.len());
        }
        tree
    }
    fn build(&mut self, blocks: &[VisibilityBlock], start: usize, end: usize) -> usize {
        let range = &blocks[start..end];
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for b in range {
            let c = Vec3::from_array([b.sphere[0], b.sphere[1], b.sphere[2]]);
            min = min.min(c);
            max = max.max(c);
        }
        let center = (min + max) * 0.5;
        let axis = Vec3::from_array([range[0].cone[0], range[0].cone[1], range[0].cone[2]]);
        let mut node = Node {
            center,
            axis,
            radius: 0.0,
            axis_deviation: 0.0,
            cone_deviation: 0.0,
            normal_length: 0.0,
            deviation: 0.0,
            start,
            end,
            right: 0,
        };
        for b in range {
            let c = Vec3::from_array([b.sphere[0], b.sphere[1], b.sphere[2]]);
            let a = Vec3::from_array([b.cone[0], b.cone[1], b.cone[2]]);
            node.radius = node.radius.max(center.distance(c) + b.sphere[3] + 0.15);
            node.axis_deviation = node.axis_deviation.max(a.distance(axis));
            node.cone_deviation = node.cone_deviation.max(a.distance(axis) + b.cone[3]);
            node.normal_length = node.normal_length.max(a.length());
            node.deviation = node.deviation.max(b.cone[3]);
        }
        let index = self.nodes.len();
        self.nodes.push(node);
        if end - start > 16 {
            let mid = (start + end) / 2;
            self.build(blocks, start, mid);
            self.nodes[index].right = self.build(blocks, mid, end);
        }
        index
    }
    pub fn select(
        &self,
        blocks: &[VisibilityBlock],
        covered: &[u8],
        view: &CullView,
        output: &mut Vec<u32>,
    ) {
        output.clear();
        if !self.nodes.is_empty() {
            self.visit(0, blocks, covered, view, output);
        }
    }
    fn visit(
        &self,
        index: usize,
        blocks: &[VisibilityBlock],
        covered: &[u8],
        view: &CullView,
        output: &mut Vec<u32>,
    ) {
        let n = &self.nodes[index];
        let delta = view.eye - n.center;
        let distance = delta.length();
        let local = view.torus && distance + n.radius < 255.9;
        let outside_blend = !view.torus || distance - n.radius > 256.1;
        let mut inside = true;
        if !local {
            for plane in view.planes {
                let signed = plane.truncate().dot(n.center) + plane.w;
                if outside_blend && signed < -n.radius - 0.1 {
                    return;
                }
                inside &= signed > n.radius + 0.1;
            }
        }
        let mut facing = !view.backfaces;
        if view.backfaces && !local {
            // Upper bound of every leaf's original facing expression:
            // ai·(eye-ci) + |eye-ci|*di + ri. Triangle inequality also
            // covers non-unit/zero cone axes and variation in cone width.
            let dot = n.axis.dot(delta);
            let upper = dot
                + distance * n.cone_deviation
                + n.radius * (n.normal_length + n.deviation + 1.0);
            if outside_blend && upper < -0.2 {
                return;
            }
            // Drop the nonnegative di and ri terms for a safe lower bound.
            facing = dot - distance * n.axis_deviation - n.radius * n.normal_length > 0.2;
        }
        if local || (inside && facing) {
            output.extend(
                (n.start..n.end)
                    .filter(|&i| covered[i] == 0)
                    .map(|i| i as u32),
            );
        } else if n.right != 0 {
            self.visit(index + 1, blocks, covered, view, output);
            self.visit(n.right, blocks, covered, view, output);
        } else {
            output.extend(
                (n.start..n.end)
                    .filter(|&i| covered[i] == 0 && view.visible_bounds(&blocks[i]))
                    .map(|i| i as u32),
            );
        }
    }
}
impl CullView {
    pub fn new(clip: Mat4, eye: Vec3, torus: bool, backfaces: bool) -> Self {
        let [x, y, z, w] = [clip.row(0), clip.row(1), clip.row(2), clip.row(3)];
        Self {
            planes: [w + x, w - x, w + y, w - y, z, w - z].map(|p| p / p.truncate().length()),
            eye,
            torus,
            backfaces,
        }
    }
    pub fn visible(&self, block: &VisibilityBlock, coverage: &Coverage) -> bool {
        if coverage.covers(block.flat) {
            return false;
        }
        self.visible_bounds(block)
    }
    pub fn visible_bounds(&self, block: &VisibilityBlock) -> bool {
        let center = Vec3::from_array(block.sphere[..3].try_into().unwrap());
        let radius = block.sphere[3] + 0.05;
        let delta = self.eye - center;
        let distance = delta.length();
        // The camera-local nonlinear blend can invalidate the uncorrected
        // sphere and cone. Keep every such block, including shadow casters.
        if self.torus && distance - radius <= 256.0 {
            return true;
        }
        if self.backfaces {
            let axis = Vec3::from_array(block.cone[..3].try_into().unwrap());
            if axis.dot(delta) + distance * block.cone[3] + radius < -0.05 {
                return false;
            }
        }
        self.planes
            .iter()
            .all(|p| p.truncate().dot(center) + p.w >= -radius)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hierarchy_matches_ordered_linear_selection() {
        let mut seed = 4181_u64;
        let mut random = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 32) as f32 / u32::MAX as f32
        };
        let blocks: Vec<_> = (0..4099)
            .map(|i| {
                let center = Vec3::new(
                    random() * 2000.0 - 1000.0,
                    random() * 300.0 - 150.0,
                    random() * 2000.0 - 1000.0,
                );
                let axis = if i % 9 == 0 {
                    Vec3::ZERO
                } else {
                    Vec3::new(random() - 0.5, random() - 0.5, random() - 0.5).normalize()
                };
                VisibilityBlock {
                    sphere: center.extend(random() * 60.0).to_array(),
                    cone: axis.extend(random() * 2.0).to_array(),
                    flat: [0.0; 4],
                }
            })
            .collect();
        let tree = VisibilityTree::new(&blocks);
        let covered: Vec<u8> = (0..blocks.len()).map(|i| u8::from(i % 7 == 0)).collect();
        let projection = Mat4::perspective_rh(70_f32.to_radians(), 1.7, 0.1, 10000.0);
        let mut selected = Vec::new();
        for i in 0..120 {
            let eye = Vec3::new(
                random() * 2000.0 - 1000.0,
                random() * 600.0,
                random() * 2000.0 - 1000.0,
            );
            let target = Vec3::new(random() * 500.0, random() * 200.0, random() * 500.0);
            let view = CullView::new(
                projection * Mat4::look_at_rh(eye, target, Vec3::Y),
                eye,
                i % 3 != 0,
                i % 2 == 0,
            );
            tree.select(&blocks, &covered, &view, &mut selected);
            let expected: Vec<_> = blocks
                .iter()
                .enumerate()
                .filter(|(i, b)| covered[*i] == 0 && view.visible_bounds(b))
                .map(|(i, _)| i as u32)
                .collect();
            assert_eq!(selected, expected, "camera {i}");
        }
    }
    #[test]
    fn coverage_keeps_partial_and_wraps_both_seams() {
        let mut c = Coverage::default();
        let mut bytes = vec![0; 1024 * 128 * 2];
        for z in [0, 127] {
            for x in [0, 1023] {
                bytes[(z * 1024 + x) * 2] = 255;
            }
        }
        c.update(&bytes);
        assert!(c.covers([-1.0, 1.0, -1.0, 1.0]));
        assert!(c.covers([16383.0, 16385.0, 2047.0, 2049.0]));
        bytes[0] = 254;
        c.update(&bytes);
        assert!(!c.covers([-1.0, 1.0, -1.0, 1.0]));
        bytes[1] = 255;
        c.update(&bytes);
        assert!(c.covers([-1.0, 1.0, -1.0, 1.0]));
        assert!(!c.covers([0.0, 100.0, 0.0, 100.0]));
    }
    #[test]
    fn shadow_keeps_backfaces_and_local_blend_keeps_uncertain_bounds() {
        let projection = Mat4::perspective_rh(70_f32.to_radians(), 1.0, 0.1, 10000.0);
        let c = Coverage::default();
        let mut b = VisibilityBlock {
            sphere: [0.0, 0.0, -500.0, 1.0],
            cone: [0.0, 0.0, -1.0, 0.0],
            flat: [1.0, 2.0, 1.0, 2.0],
        };
        assert!(!CullView::new(projection, Vec3::ZERO, true, true).visible(&b, &c));
        assert!(CullView::new(projection, Vec3::ZERO, true, false).visible(&b, &c));
        b.sphere = [0.0, 0.0, 500.0, 1.0];
        assert!(!CullView::new(projection, Vec3::ZERO, true, false).visible(&b, &c));
        b.sphere = [0.0, 0.0, 50.0, 1.0];
        assert!(CullView::new(projection, Vec3::ZERO, true, false).visible(&b, &c));
    }
}
