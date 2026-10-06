import type { DecorationDefinition } from '../contraption/Decorations.ts';
import type { GradientStop, PaletteEntry } from '../voxel/Palette.ts';

/** Data contracts shared by the codec and the browser. No engine instances or DOM. */
export type InventoryKind = 'item' | 'blockset' | 'entity' | 'colorset';
export type BodyType = 'dynamic' | 'kinematic';
export type ConstraintType = 'point' | 'hinge' | 'weld';

export interface BodyProperties {
  mass?: number;
  restitution?: number;
  friction?: number;
  useGravity?: boolean;
  collisionEnabled?: boolean;
}

export interface InventorySeat {
  position: number[];
  rotation?: number[];
  fixedOrientation?: boolean;
}

export interface InventoryConstraint {
  id: string;
  type: ConstraintType;
  bodyA: string | null;
  bodyB: string;
  anchorA?: number[];
  anchorB?: number[];
  axisA?: number[];
  axisB?: number[];
  referenceA?: number[];
  referenceB?: number[];
  limits?: { min: number; max: number } | null;
  stiffness?: number;
  collideConnected?: boolean;
  /** Read-only compatibility with old in-memory constraints. Never emitted. */
  nodeId?: string;
}

export interface VoxelAppearance {
  block?: number;
  color?: number;
  materialId?: number;
  part?: string | null;
  size?: number;
}

export interface PortableVoxel extends VoxelAppearance {
  dx: number;
  dy: number;
  dz: number;
  mx?: number;
  my?: number;
  mz?: number;
  entityId?: string;
}

export interface ComponentProperties extends BodyProperties {
  name?: string;
  pivot?: number[];
  localPosition?: number[];
  localRotation?: number[];
  anchorRotation?: number[];
  bodyType?: BodyType;
  seats?: Array<InventorySeat | number[]>;
  decorations?: DecorationDefinition[];
}

export interface InventoryChild extends ComponentProperties {
  /** Legacy import metadata; serializers omit these fields. */
  kind?: string; index?: number;
  position?: { x: number; y: number; z: number };
  blockKeys?: Array<string | Array<string | number>>;
  id: string;
  parentId: string;
}

export interface PortableComponent {
  id: string;
  name?: string;
  pivot?: number[];
  localPosition?: number[];
  localRotation?: number[];
  anchorRotation?: number[];
  body: BodyProperties & { type: BodyType };
  blocks: PortableVoxel[];
  children: PortableComponent[];
  seats: InventorySeat[];
  decorations?: DecorationDefinition[];
  script?: string;
  scriptLanguage?: 'assemblyscript';
  scriptDisabled?: boolean;
}

export interface PortableEntity {
  type: 'space-entity';
  version: number;
  root: PortableComponent;
  constraints: InventoryConstraint[];
}

export interface PortableBlockSet {
  type: 'space-blockset';
  version: number;
  name: string;
  blocks: PortableVoxel[];
}

export interface PortableColorSet {
  type: 'space-colorset';
  version: number;
  name: string;
  entries: Array<{ stops: GradientStop[]; materialId: number }>;
}

export interface PortableItem {
  type: 'space-item';
  version: number;
  id: string;
  name: string;
  blockSet?: PortableBlockSet;
  entityList: PortableEntity[];
}

export interface PortableResourceMap {
  item: PortableItem;
  entity: PortableEntity;
  blockset: PortableBlockSet;
  colorset: PortableColorSet;
}
export type PortableResource = PortableResourceMap[InventoryKind];
export type DecodedInventoryResource = {
  [K in InventoryKind]: { category: K; portable: PortableResourceMap[K] }
}[InventoryKind];

/** Legacy callers may supply either coordinate convention; import produces the
 * concrete BlockSetVoxel / EntityVoxel types below after validating the wire data. */
export interface InventoryVoxel extends VoxelAppearance {
  dx?: number;
  dy?: number;
  dz?: number;
  localX?: number;
  localY?: number;
  localZ?: number;
  entityId?: string;
}
export interface BlockSetVoxel extends InventoryVoxel { dx: number; dy: number; dz: number }
export interface EntityVoxel extends InventoryVoxel { localX: number; localY: number; localZ: number; entityId: string }

/** Projection accepted by geometry/serialization, including legacy in-memory slots.
 * Optional fields are intentional: serializers supply defaults and import validates. */
export interface InventoryInput extends ComponentProperties {
  kind?: string;
  id?: string;
  type?: string;
  version?: number;
  blocks?: InventoryVoxel[];
  blockCount?: number;
  nodeCount?: number;
  rootComponentId?: string;
  rootPivotOverride?: number[];
  childEntities?: InventoryChild[];
  scripts?: Array<{ id: string; code: string; language?: string }>;
  enabled?: Array<{ id: string; enabled: boolean }>;
  constraints?: InventoryConstraint[];
  mode?: string;
  blockSet?: InventoryBlockSet;
  entityList?: InventoryEntity[];
  itemPosition?: number[];
  itemRotation?: number[];
  itemWorldConstraints?: boolean;
  sourcePosition?: number[];
  sourceRotation?: number[];
  entries?: Array<Partial<PaletteEntry>>;
  colors?: Array<string | number>;
}

export interface InventoryBlockSet extends InventoryInput {
  kind: 'blockset';
  name: string;
  blocks: BlockSetVoxel[];
  blockCount: number;
}
export interface InventoryEntity extends InventoryInput {
  kind: 'entity';
  name: string;
  rootComponentId: string;
  blocks: EntityVoxel[];
  blockCount: number;
  nodeCount: number;
  childEntities: InventoryChild[];
  scripts: Array<{ id: string; code: string; language?: string }>;
  enabled: Array<{ id: string; enabled: boolean }>;
  constraints: InventoryConstraint[];
}
export interface InventoryItem extends InventoryInput {
  kind: 'item';
  id: string;
  name: string;
  entityList: InventoryEntity[];
  blocks: InventoryVoxel[];
  blockCount: number;
  nodeCount: number;
}
export interface InventoryColorSet extends InventoryInput {
  kind?: 'colorset';
  name: string;
  entries: PaletteEntry[];
}
export type InventoryResource = InventoryItem | InventoryBlockSet | InventoryEntity | InventoryColorSet;
export interface InventoryResourceMap {
  item: InventoryItem | InventoryEntity;
  blockset: InventoryBlockSet;
  entity: InventoryEntity;
  colorset: InventoryColorSet;
}

/** Codec flattening retains integral cell + micro offsets until the importer
 * converts them to construction-space coordinates. */
export interface FlatPortableEntity extends Omit<InventoryEntity, 'kind' | 'blocks'> {
  blocks: Array<PortableVoxel & { entityId: string }>;
}
