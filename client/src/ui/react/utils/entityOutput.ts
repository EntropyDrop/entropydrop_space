import type { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import type { EntityOutputEntry } from '@entropydrop/space-engine/contraption/EntityOutput.ts';
import { entityDisplayName } from './entityNameplate.ts';

export interface EntityOutputView extends EntityOutputEntry {
  id: number;
  entityId: string;
  entityName: string;
  observedEntityId: string;
}

export function filterEntityOutput(entries: readonly EntityOutputView[], entityId = '', type = '') {
  return entries.filter(entry => (!entityId || entry.entityId === entityId)
    && (!type || (type.startsWith('message:')
      ? entry.kind === 'message' && entry.messageType === type.slice(8) : entry.kind === type)));
}

/** Poll bounded entity buffers with monotonic cursors; repeated text is still a new event. */
export class EntityOutputCollector {
  private cursors = new WeakMap<object, number>();
  private sequence = 0;
  private entries: EntityOutputView[] = [];

  collect(entities: readonly Contraption[]): EntityOutputView[] {
    const nearby = new Map(entities.map(entity => [String(entity.publicId || entity.id), entity]));
    let next = this.entries.filter(entry => nearby.has(entry.observedEntityId));
    const messageIds = new Set(next.filter(entry => entry.messageId).map(entry => entry.messageId));
    for (const entity of entities) {
      const buffer = entity.output;
      if (!buffer) continue;
      const lastSequence = this.cursors.get(buffer) || 0;
      const observedEntityId = String(entity.publicId || entity.id);
      for (const entry of buffer.entries) {
        if (entry.sequence <= lastSequence) continue;
        this.cursors.set(buffer, entry.sequence);
        if (entry.messageId && messageIds.has(entry.messageId)) continue;
        if (entry.messageId) messageIds.add(entry.messageId);
        const entityId = entry.sourceId || observedEntityId;
        const source = nearby.get(entityId);
        next.push({ ...entry, id: ++this.sequence, entityId, observedEntityId,
          entityName: source ? entityDisplayName(source) : entityId });
      }
    }
    next.sort((left, right) => left.timestamp - right.timestamp || left.id - right.id);
    next = next.slice(-500);
    if (next.length === this.entries.length && next.every((entry, index) => entry === this.entries[index])) return this.entries;
    this.entries = next;
    return next;
  }

  clear(entities: readonly Contraption[]): EntityOutputView[] {
    this.collect(entities);
    this.entries = [];
    return this.entries;
  }
}
