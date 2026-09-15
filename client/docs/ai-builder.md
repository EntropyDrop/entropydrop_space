# Agent Build

[spaceAPI](../../server/space/agent/spaceAPI.md) · [entityAPI](../../engine/docs/generated/api-v2.md)

entityAPI is the runtime interface called by entity code through `self` / `ctx`; spaceAPI is the HTTP interface used by agents and clients.

The HUD **AGENT BUILD** entry replaces the retired AI BUILD assistant. It provides connection instructions and spaceAPI key management for an external agent; it does not call a model or generate BuildPlan JSON in the browser. The entity code editor's AI assistant is unchanged.

## Flow

1. Open **AGENT BUILD** in the HUD.
2. Copy **Agent Prompt** to your external agent. The prompt contains the configured Space backend URL and public Skill link, never a credential.
3. Sign in and enter online Space to create a spaceAPI key, or use an existing key. Give the key only to an agent you trust when it asks.
4. Describe the structure or entity to build. The agent reads the public Skill and uses authenticated spaceAPI requests to locate the player and perform supported operations.
5. Keep Space open for position updates and browser-executed entities. Stop entities before editing; backend ownership, revision checks, and quotas remain enforced.
6. Revoke the key in this panel or Global Settings → API when it is no longer needed.

All existing and new spaceAPI keys have full Space permissions. A spaceAPI key is not a model-provider API key. Opening the panel does not create or revoke keys. Offline users can read and copy the instructions, but API key management and remote builds require online Space. A localhost backend is reachable only by an agent on the same machine.

## Legacy BuildPlan V1 (retired)

The following contract is retained as a source reference for `SpaceBuilder` and `BuildAgent` tests. Neither module is connected to the application startup, HUD, render loop, or Agent Build panel. The old model-chat, hologram-preview, confirmation, cancellation, and undo workflow is no longer exposed.

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
    /** Fixes the rider's body to the seat's world orientation; camera look stays free. */
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

## Legacy runtime service

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
