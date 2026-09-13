# HUD AI Builder

[spaceAPI](../../../entropydrop_backend/space/agent/spaceAPI.md) · [entityAPI](../../engine/docs/generated/api-v2.md)

entityAPI 是实体代码中通过 `self` / `ctx` 调用的运行时接口；spaceAPI 是 Agent 和客户端使用的 HTTP 接口。

The HUD AI Builder currently generates declarative plans; its planned HTTP tool integration uses spaceAPI. Entity scripts use entityAPI. A model produces a declarative `SpaceBuildPlan`; the engine validates it, renders a hologram, and waits for explicit player confirmation before changing the world.

## Flow

1. Aim at a placement surface and open **AI BUILD** in the HUD.
2. Describe a world structure or physics entity.
3. The model returns a BuildPlan JSON object.
4. `SpaceBuilder.validate()` expands primitives and checks grids, bounds, occupancy, component references, scripts, constraints, world height, and player overlap.
5. `SpaceBuilder.preview()` reuses the Hammer hologram renderer without mutating the world.
6. Player confirmation calls `SpaceBuilder.commit()`.
7. Large plans commit in bounded frame slices and respect terrain-sync backpressure. Cancel rolls back admitted structure voxels; completed builds can be undone.

## BuildPlan V1

The authoritative types are `SpaceBuildPlanInput` and friends in
`src/engine/building/SpaceBuilder.ts`; the shape below mirrors them.

```ts
type SpaceBuildKind = 'structure' | 'entity';
type SpaceBuildAnchor = 'crosshair' | [number, number, number];

interface SpaceBuildVoxelInput {
  x: number;
  y: number;
  z: number;
  /** MICRO_SIZE is 0.125 m (8×8×8 grid); omit for a standard 1 m voxel. */
  size?: 1 | 0.125;
  color?: number | string;
  componentId?: string;
}

interface SpaceBuildPrimitiveInput {
  type: 'box' | 'line';
  from: [number, number, number];
  to: [number, number, number];
  hollow?: boolean;
  size?: 1 | 0.125;
  color?: number | string;
  componentId?: string;
}

interface SpaceBuildComponentInput {
  id: string;
  name?: string;
  parentId?: string | null;
  pivot?: [number, number, number];
  bodyType?: 'dynamic' | 'kinematic';
  mass?: number;
  restitution?: number;
  friction?: number;
  useGravity?: boolean;
  collisionEnabled?: boolean;
  seats?: Array<[number, number, number] | {
    position: [number, number, number];
    /** Rider orientation `[x,y,z,w]` in the component pivot frame; identity faces -Z. */
    rotation?: [number, number, number, number];
    /** When true a mounted rider's yaw follows the seat's solved world orientation. */
    fixedOrientation?: boolean;
  }>;
  script?: string;
  scriptEnabled?: boolean;
}

interface SpaceBuildConstraintInput {
  id: string;
  type: 'point' | 'hinge' | 'weld';
  /** Null selects the external world anchor; strings always name components. */
  bodyA: string | null;
  bodyB: string;
  anchorA?: [number, number, number];
  anchorB?: [number, number, number];
  axisA?: [number, number, number];
  axisB?: [number, number, number];
  limits?: { min: number; max: number };
  stiffness?: number;
  collideConnected?: boolean;
}

interface SpaceBuildPlanInput {
  version?: 1;
  kind: SpaceBuildKind;
  name?: string;
  anchor?: SpaceBuildAnchor;
  blocks?: SpaceBuildVoxelInput[];
  primitives?: SpaceBuildPrimitiveInput[];
  components?: SpaceBuildComponentInput[];
  constraints?: SpaceBuildConstraintInput[];
  bodyType?: 'dynamic' | 'kinematic';
  mass?: number;
  restitution?: number;
  friction?: number;
  useGravity?: boolean;
  collisionEnabled?: boolean;
}
```

`structure` plans write ordinary world voxels. `entity` plans are converted into the existing serialized Entity slot format and registered through `ContraptionManager.buildFromSlot()`.

Limits are exported by `SpaceBuilder.ts`: 65,536 voxels, 256 constraints, 64 components,
hierarchy depth 16, 64 metres per axis, 64 KiB per script, and 512 KiB of scripts per entity
(`MAX_BUILD_PLAN_VOXELS`, `MAX_BUILD_PLAN_CONSTRAINTS`, `MAX_BUILD_SCRIPT_BYTES`,
`MAX_BUILD_TOTAL_SCRIPT_BYTES`). Frame slicing uses `BUILD_OPERATIONS_PER_FRAME` (1024) and
`BUILD_FRAME_BUDGET_MS` (5).

## Runtime service

```ts
builder.validate(plan)
builder.preview(plan)
builder.getRenderPreview()
builder.clearPreview()
builder.commit(plan?)
builder.update(maxOperations?, timeBudgetMs?)
builder.getJob(jobId?)
builder.cancel(jobId?)
builder.undo(commitId?)
builder.getHistory()
```

Queued jobs expose preparation, application, backpressure, rollback, completion, failure, and cancellation phases. World writes use the canonical `BasicActions` path with actor source `agent`; Entity builds reuse the existing hierarchy, physics, persistence, and script sandbox.
