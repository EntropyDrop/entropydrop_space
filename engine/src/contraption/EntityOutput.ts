export type EntityOutputKind = 'console' | 'message' | 'system' | 'warning' | 'error';

export interface EntityOutputEntry {
  sequence: number;
  timestamp: number;
  kind: EntityOutputKind;
  text: string;
  nodeId?: string;
  sourceId?: string;
  targetId?: string;
  messageId?: string;
  messageType?: string;
  direction?: 'incoming' | 'outgoing';
  status?: string;
}

/** Ephemeral diagnostics only: never serialized into an entity or checkpoint. */
export class EntityOutputBuffer {
  readonly entries: EntityOutputEntry[] = [];
  private sequence = 0;

  append(entry: Omit<EntityOutputEntry, 'sequence' | 'timestamp'>) {
    const output = Object.freeze({ ...entry, text: entry.text.slice(0, 4096),
      sequence: ++this.sequence, timestamp: Date.now() });
    this.entries.push(output);
    if (this.entries.length > 200) this.entries.splice(0, this.entries.length - 200);
    return output;
  }
}

export function entityMessageText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return `Protobuf (${payload.length} bytes): ${payload.slice(0, 64)
    .map(byte => Number(byte).toString(16).padStart(2, '0')).join(' ')}${payload.length > 64 ? ' …' : ''}`;
  return '';
}
