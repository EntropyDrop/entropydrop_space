export const SCRIPT_DATA_LIMIT_BYTES = 1024 * 1024;
export const BLOCKED_SCRIPT_DATA_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export class ScriptBudgetError extends Error {}

type DataBudget = { bytes: number; nodes: number };

/** Copying and validation share the same accounting, including repeated aliases. */
function visitData(value: unknown, budget: DataBudget, depth: number, copy: boolean): any {
  if (++budget.nodes > 16384 || depth > 32) throw new ScriptBudgetError('Entity data exceeds structural limits');
  budget.bytes += typeof value === 'string' ? value.length * 2 : 8;
  if (budget.bytes > SCRIPT_DATA_LIMIT_BYTES) throw new ScriptBudgetError('Entity data exceeds 1 MiB');
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') throw new Error('Only JSON data may cross the WASM boundary');
  const record = value as Record<string, unknown>;
  const out: any = copy ? (Array.isArray(value) ? [] : Object.create(null)) : undefined;
  for (const key of Object.keys(record)) {
    if (BLOCKED_SCRIPT_DATA_KEYS.has(key)) throw new Error('Reserved entity data key');
    budget.bytes += key.length * 2;
    const child = visitData(record[key], budget, depth + 1, copy);
    if (copy) out[key] = child;
  }
  return out;
}

/** Clone only bounded JSON data; never copy functions or prototype properties. */
export function copyScriptData(value: unknown, budget: DataBudget = { bytes: 0, nodes: 0 }): any {
  return visitData(value, budget, 0, true);
}

export function validateScriptData(value: unknown): void {
  visitData(value, { bytes: 0, nodes: 0 }, 0, false);
}

/** Validate the proposed record before mutating it, without a spread or deep copy.
 * Array writes deliberately use the same enumerable-key accounting as record
 * writes. The runtime separately enforces valid contiguous array indices. */
export function validateScriptDataWrite(target: object, replacementKey: string, replacementValue: unknown): void {
  const budget = { bytes: 8, nodes: 1 };
  const record = target as Record<string, unknown>;
  let seen = false;
  for (const key of Object.keys(record)) {
    if (BLOCKED_SCRIPT_DATA_KEYS.has(key)) throw new Error('Reserved entity data key');
    budget.bytes += key.length * 2;
    const replacement = key === replacementKey;
    if (replacement) seen = true;
    visitData(replacement ? replacementValue : record[key], budget, 1, false);
  }
  if (!seen) {
    if (BLOCKED_SCRIPT_DATA_KEYS.has(replacementKey)) throw new Error('Reserved entity data key');
    budget.bytes += replacementKey.length * 2;
    visitData(replacementValue, budget, 1, false);
  }
}
