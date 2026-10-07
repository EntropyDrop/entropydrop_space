import type { BodyTypeValue, Contraption } from '../contraption/Contraption.ts';
import type { ContraptionManager } from '../contraption/ContraptionManager.ts';
import type { ConstraintInput, ContraptionOptions, EntityNode, RuntimeConstraint, RuntimeVoxel } from '../contraption/EntityTypes.ts';
import type { CollisionBounds } from '../physics/CollisionGeometry.ts';
import type { World } from '../voxel/World.ts';

export type ActionPoint = readonly number[] | { x: number; y: number; z: number };
export type ActionMicroPoint = ActionPoint | { mx: number; my: number; mz: number };
export interface ActionActor { source: 'player' | 'script' | 'server-sync' | 'system'; playerId?: string | null }
export interface EntityTarget { contraption?: Contraption | null; entityId?: string | number; id?: string | number; nodeId?: string }
export interface ActionAppearance { color?: number; r?: number; g?: number; b?: number; materialId?: number; fromColor?: number }
type Appearance = { color?: number; options?: ActionAppearance | null };
type Cell = { cell: ActionPoint; position?: ActionPoint } | { position: ActionPoint; cell?: ActionPoint };
type Micro = { micro: ActionMicroPoint };
type Empty = Record<never, never>;
type Commands<D extends string, M> = { [A in keyof M]: { domain: D; action: A; actor?: ActionActor } & M[A] }[keyof M];

type WorldInputs = {
  'get-standard': Cell; 'get-micro': Micro;
  'place-standard': Cell & Appearance & { block?: number; replace?: boolean; updateMesh?: boolean };
  'remove-standard': Cell & { updateMesh?: boolean };
  'paint-standard': Cell & Appearance;
  'place-micro': Micro & Appearance & { replace?: boolean; part?: string | null };
  'remove-micro': Micro; 'paint-micro': Micro & Appearance;
  'clear-cell': Cell; 'subdivide-standard': Cell & { micro?: ActionMicroPoint };
  'remove-cells': { cells: ActionPoint[]; microOnly?: boolean };
  'paint-cells': { cells: ActionPoint[]; microOnly?: boolean; fromColor?: number } & Appearance;
};
export type WorldActionCommand = Commands<'world', WorldInputs>;
type EntityInputs = Omit<WorldInputs, 'get-standard' | 'get-micro' | 'remove-cells' | 'paint-cells'> & {
  'subdivide-cells': { cells: ActionPoint[] };
  'fill-blocks': { coords: { x: number; y: number; z: number }[]; colors?: number[]; micro?: boolean } & Appearance;
  'paint-blocks': { blocks: RuntimeVoxel[]; colors?: number[]; fromColor?: number } & Appearance;
  'remove-blocks': { blocks: RuntimeVoxel[] };
  'remove-subtree': Empty; 'start-scripts': Empty; 'stop-scripts': Empty; 'toggle-scripts': Empty; 'disassemble': Empty;
};
export type EntityActionCommand = Commands<'entity', EntityInputs> & { target?: EntityTarget; nodeId?: string };
export interface EntityActionSelection {
  kind?: 'entity-blocks' | 'entity-subtree'; contraption: Contraption;
  nodeId?: string; rootId?: string; nodeIds?: Set<string>; blocks?: RuntimeVoxel[]; micro?: boolean; components?: string[];
}
type SelectionInputs = {
  get: Empty; clear: Empty;
  'corner-a': { point: ActionPoint; micro?: boolean }; 'corner-b': { point: ActionPoint; micro?: boolean };
  box: ({ a: ActionPoint; b: ActionPoint } | { cornerA: ActionPoint; cornerB: ActionPoint }) & { micro?: boolean };
  cells: { cells: ActionPoint[] }; 'toggle-cell': { point: ActionPoint; micro?: boolean };
  'entity-subtree': { target?: EntityTarget; entityId?: string | number; nodeId?: string };
  'entity-box': { target?: EntityTarget; entityId?: string | number; nodeId?: string; a: ActionPoint; b: ActionPoint; space?: 'node-local' | 'entity-local' | 'world'; micro?: boolean; allComponents?: boolean };
  'toggle-entity-block': { target?: EntityTarget; entityId?: string | number; nodeId?: string; block: RuntimeVoxel };
  delete: { selection?: EntityActionSelection };
  paint: { selection?: EntityActionSelection; fromColor?: number } & Appearance;
  fill: { selection?: EntityActionSelection } & Appearance;
  assemble: { mode?: string; options?: ContraptionOptions; prepared?: { blocks: RuntimeVoxel[]; origin: { x: number; y: number; z: number } } };
  'create-child': { selection?: EntityActionSelection; id?: string };
};
export type SelectionActionCommand = Commands<'selection', SelectionInputs>;
type PhysicsInputs = {
  'get-body': Empty; 'set-body-type': { bodyType: BodyTypeValue };
  'set-body-mass': { mass: number }; 'set-body-material': { material: { restitution?: number; friction?: number } };
  'set-body-gravity-enabled': { enabled: boolean }; 'set-body-collision-enabled': { enabled: boolean };
  'apply-body-force': { force: ActionPoint }; 'apply-body-torque': { torque: ActionPoint };
  'create-constraint': { definition: ConstraintInput }; 'remove-constraint': { constraintId: string }; 'get-constraints': Empty;
};
export type PhysicsActionCommand = Commands<'physics', PhysicsInputs> & { target?: EntityTarget; nodeId?: string; runtimeOnly?: boolean };
export type QueryActionCommand = { domain: 'query'; action: 'raycast'; origin: ActionPoint; direction: ActionPoint;
  maxDistance?: number; space?: 'bent' | 'world'; include?: 'all' | 'entities' | 'world';
  voxelKinds?: Array<'standard' | 'micro'>; usePublishedCollision?: boolean; actor?: ActionActor };
/** Internal handlers validate each unknown field before using it. */
export type ActionPayload = { action: string } & Record<string, unknown>;

export type BasicActionCommand = WorldActionCommand | EntityActionCommand | SelectionActionCommand | PhysicsActionCommand | QueryActionCommand;

type ReportedAction<A extends string> = A extends 'delete' ? A | 'remove-cells' | 'remove-blocks' | 'remove-subtree'
  : A extends 'paint' | 'fill' ? A | 'paint-blocks' : A;

export interface ActionOutcome<A extends string = string> {
  ok: boolean; action: ReportedAction<A>; changed: number; reason: string;
  placed?: number; removed?: number; painted?: number; subdivided?: number; added?: number; recolored?: number;
  cleared?: number; selected?: number; assembled?: number; disassembled?: number; applied?: number;
  standard?: number; micro?: number; color?: number; materialId?: number; empty?: boolean; clamped?: boolean; materialized?: number;
  status?: string; physicsEnabled?: boolean; components?: A extends 'entity-box' | 'create-child' ? string[] : A extends 'remove-subtree' | 'delete' ? number : string[] | number;
  contraption?: Contraption | null; entities?: number; nodeId?: string;
  entity?: Contraption | null; entityId?: string | null; runtimeId?: string | number | null;
  child?: EntityNode | null; childId?: string | null;
  bodyType?: BodyTypeValue | null; mass?: number | null; enabled?: boolean | null;
  material?: { restitution: number; friction: number } | null; constraint?: RuntimeConstraint | null;
  selection?: A extends 'entity-box' | 'toggle-entity-block'
    ? (EntityActionSelection & { kind: 'entity-blocks'; blocks: RuntimeVoxel[]; nodeId: string; components?: string[] }) | null
    : A extends 'entity-subtree' ? (EntityActionSelection & { kind: 'entity-subtree'; nodeIds: Set<string>; nodeId: string }) | null
    : A extends 'toggle-cell' ? SelectionView | null : EntityActionSelection | SelectionView | null;
}
export interface SelectionView {
  kind?: string; mode?: string; entityId?: string | null; runtimeId?: string | number | null; nodeId?: string;
  count?: number; ready?: boolean; pointCount?: number; cells?: { x: number; y: number; z: number }[] | null; granularity?: string; bounds?: CollisionBounds | null; rejected?: boolean;
}
export interface BodyView {
  nodeId: string; type: BodyTypeValue; mass: number; restitution: number; friction: number;
  useGravity: boolean; collisionEnabled: boolean; velocity: readonly number[]; angularVelocity: readonly number[];
}
export type WorldVoxelView = { block: number; color: number; materialId?: number; part?: string | null };
export interface ActionRaycastResult {
  ok: boolean; action: 'raycast'; reason: string; kind?: 'world' | 'entity' | null;
  hit: ReturnType<World['raycast']> | ReturnType<World['raycastMicro']> | ReturnType<ContraptionManager['raycastContraptionHit']>;
  worldHit: ReturnType<World['raycast']> | ReturnType<World['raycastMicro']>;
  entityHit: ReturnType<ContraptionManager['raycastContraptionHit']>;
}
export type BasicActionResult<C extends BasicActionCommand> =
  C extends QueryActionCommand ? ActionRaycastResult :
  C extends { domain: 'world'; action: 'get-standard' | 'get-micro' } ? WorldVoxelView | ActionOutcome<C['action']> :
  C extends { domain: 'selection'; action: 'get' } ? SelectionView | ActionOutcome<'get'> :
  C extends { domain: 'physics'; action: 'get-body' } ? BodyView | ActionOutcome<'get-body'> | null :
  C extends { domain: 'physics'; action: 'get-constraints' } ? readonly RuntimeConstraint[] | ActionOutcome<'get-constraints'> :
  ActionOutcome<C['action']>;

/** Script/IPC adapters retain known operation names while validating unknown payloads at runtime. */
export type BasicActionInput = BasicActionCommand extends infer C ? C extends BasicActionCommand
  ? { domain: C['domain']; action: C['action'] } & { [K in Exclude<keyof C, 'domain' | 'action'>]?: unknown } : never : never;
export type BasicActionInputResult<C extends BasicActionInput> = BasicActionResult<Extract<BasicActionCommand, { domain: C['domain']; action: C['action'] }>>;

export type EntityActionInput = Extract<BasicActionInput, { domain: 'entity' }> extends infer C ? C extends { domain: 'entity' } ? Omit<C, 'domain'> & { domain?: 'entity' } : never : never;

/** Only the mutable selection references used by the action dispatcher. */
export interface ActionSelectionHost {
  entitySelection?: EntityActionSelection | null;
  selectedBlockSelection?: EntityActionSelection | null;
  selectedSubtree?: EntityActionSelection | null;
  childSelection?: { contraption: Contraption } | null;
  selectorLevel?: { contraption: Contraption } | null;
  selectorRange?: { contraption: Contraption | null } | null;
}

type ActionWorldMethods = Pick<World,
  'getBlock' | 'getBlockColor' | 'getBlockMaterial' | 'setBlock' | 'setBlockAppearance'
  | 'hasMicroInStandardCell' | 'getMicroBlock' | 'getMicroBlockPart' | 'setMicroBlock'
  | 'removeMicroBlock' | 'clearMicroStandardCell' | 'subdivideBlock'
  | 'raycast' | 'raycastBent' | 'raycastMicro' | 'raycastMicroBent'>;
/** Void-returning write adapters are supported by the dispatcher. */
export type ActionWorld = Partial<Omit<ActionWorldMethods, 'setBlock'>> & {
  setBlock?: (...args: Parameters<World['setBlock']>) => boolean | void;
  microVoxels?: Partial<Pick<World['microVoxels'], 'hasAnyInStandardCell'>>;
};
export type ActionManager = Partial<Pick<ContraptionManager,
  'contraptions' | 'removeContraption' | 'disassembleContraption' | 'clearSelection'
  | 'setCornerA' | 'setCornerB' | 'getSelectionBlockCount' | 'setConnectedSelection'
  | 'toggleMicroCell' | 'toggleWorldGlueCell' | 'getWorldGlueSelectionInfo' | 'getSelectionBounds'
  | 'hasValidSelection' | 'microSelection' | 'microBounds' | 'partitionMicroSelection'
  | 'connectedSelection' | 'normalizeAssemblyMode' | 'commitPreparedAssembly' | 'assembleSelection'
  | 'hasReadyChildSelection' | 'createChildFromSelection' | 'raycastContraptionHit' | 'raycastContraptionHitBent'>> & ActionSelectionHost & {
    world?: ActionWorld | null;
    controller?: { wrenchGrab?: { contraption: Contraption } | null } | null;
  };
export interface BasicActionContext {
  world?: ActionWorld | null;
  manager?: ActionManager | null;
  contraption?: Contraption | null;
  selectionHost?: ActionSelectionHost | null;
}
