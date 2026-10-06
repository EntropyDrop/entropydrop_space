import type { DecorationDefinition } from '../contraption/Decorations.ts';
/** Data and capabilities crossing the entity script runtime boundary. */
export interface ScriptInputState {
  down?: ReadonlySet<string> | readonly string[];
  pressed?: ReadonlySet<string> | readonly string[];
  released?: ReadonlySet<string> | readonly string[];
}
export interface ScriptCommand {
  commandId?: string;
  scope: string;
  nodeId?: string | null;
  path: string;
  args?: unknown[];
}
export interface ScriptRuntimeResult {
  ok?: boolean;
  requestId?: number;
  nodeId?: string;
  error?: string;
  stale?: boolean;
  pending?: boolean;
  fatal?: boolean;
  elapsedMs?: number;
  stopped?: boolean;
  errors?: Array<{ nodeId?: string; error?: string }>;
  commands?: ScriptCommand[];
  states?: Record<string, unknown>;
  frozenStatePaths?: string[][];
  executionTimes?: Record<string, number>;
}
export interface ScriptPlayer {
  id?: string;
  position?: readonly number[]; eyePosition?: readonly number[]; feetPosition?: readonly number[];
  velocity?: readonly number[];
  yaw?: number; pitch?: number; mass?: number;
  isLocal?: boolean; isOnGround?: boolean; isFlying?: boolean; isCrouching?: boolean;
  isSprinting?: boolean; isInWater?: boolean;
  ridingEntityId?: string | null; ridingBodyId?: string | null; avatarEntityId?: string | null;
}
export interface ScriptWorldApi {
  entities?(position: number[], radius: number): readonly unknown[];
  getInfo?(): unknown;
  raycast?(origin: unknown, direction: unknown, options?: unknown): unknown;
  voxels?: { get(location: unknown): unknown };
  microVoxels?: { get(location: unknown, offset: unknown): unknown };
}
export interface ScriptRuntimeContext {
  players?: ScriptPlayer[];
  gravity?: number[];
  driver?: { entityId: string; playerId?: string | null; componentId?: string; seatIndex?: number } | null;
  world?: ScriptWorldApi | null;
  selection?: { get?(): unknown } | null;
  messages?: { send(sourceId: string, ...args: unknown[]): unknown };
}
export interface ScriptContact {
  kind?: string;
  selfNodeId?: string;
  otherEntityId?: string | null;
  otherNodeId?: string | null;
  playerId?: string | null;
  position?: number[];
  normal?: number[];
  relativeVelocity?: number[];
  impulse?: number;
  penetration?: number;
  sleeping?: boolean;
  key?: string;
}
export type EntityMessage = {
  messageId: string; sourceId: string; targetId: string; type: string;
} & ({ encoding: 'utf8'; payload: string } | { encoding: 'protobuf'; payload: number[] });

export interface ScriptComponentSnapshot {
  id: string; parentId?: string | null; children?: string[];
  worldPosition?: number[]; worldRotation?: number[]; pivot?: number[];
  localPosition?: number[]; localRotation?: number[];
  bounds?: unknown; seats?: unknown[]; constraints?: readonly unknown[];
  decorations?: DecorationDefinition[];
  body?: { type?: string; mass?: number; material?: unknown; useGravity?: boolean; collisionEnabled?: boolean; velocity?: number[]; angularVelocity?: number[] };
}
export interface ScriptSnapshot {
  states?: Record<string, unknown>;
  components?: ScriptComponentSnapshot[];
  rootComponentId?: string; entityId?: string; commandSequence?: number;
  time?: number; deltaTime?: number; tick?: number;
  position?: number[]; velocity?: number[]; rotation?: number[]; angularVelocity?: number[];
  groundDistance?: number; isOnGround?: boolean; mass?: number; bodyType?: string;
  gravity?: number[]; limits?: unknown;
  input?: { down?: string[]; pressed?: string[]; released?: string[] };
  blocks?: { changed?: boolean; event?: { type?: string } | null };
  players?: unknown[]; driver?: unknown; contacts?: ScriptContact[]; messages?: unknown[];
  commandResults?: Array<{ commandId?: string }>;
  world?: { entities?: Record<string, unknown>[]; size?: number[]; info?: unknown };
  selection?: Record<string, unknown> | null;
}
