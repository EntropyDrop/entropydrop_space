import type { ScriptClickedBlock } from './ScriptProtocol.ts';

/** Copy only the documented fields at the native input boundary. */
export function normalizeClickedBlock(input: unknown): ScriptClickedBlock | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const id = (key: string, limit = 64) => typeof value[key] === 'string'
    && (value[key] as string).length > 0 && (value[key] as string).length <= limit;
  const vector = (key: string): [number, number, number] | null => {
    const v = value[key];
    return Array.isArray(v) && v.length === 3
      && v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e9)
      ? [v[0], v[1], v[2]] : null;
  };
  const position = vector('position'), point = vector('point'), localPoint = vector('localPoint');
  if (!id('eventId') || !id('entityId') || !id('playerId') || !id('nodeId', 128)
    || !position || !point || !localPoint) return null;
  const kind = value.kind;
  if (kind === 'decoration' ? !id('decorationId', 128) || value.size !== null
    : kind === 'standard' ? value.size !== 1 || value.decorationId !== null
    : kind === 'micro' ? value.size !== 0.125 || value.decorationId !== null : true) return null;
  return {
    eventId: value.eventId as string, entityId: value.entityId as string,
    playerId: value.playerId as string, nodeId: value.nodeId as string,
    kind: kind as ScriptClickedBlock['kind'], position, point, localPoint,
    size: value.size as number | null, decorationId: value.decorationId as string | null,
  };
}
