import { readRecord } from '../contraption/EntityInput.ts';
import type { ActionPayload, BasicActionCommand, BasicActionContext, BasicActionInput, BasicActionInputResult, BasicActionResult } from './ActionContracts.ts';
import { actionResult } from './ActionValues.ts';
import { executeEntityAction } from './EntityActions.ts';
import { executePhysicsAction } from './PhysicsActions.ts';
import { executeQueryAction } from './QueryActions.ts';
import { executeSelectionAction } from './SelectionActions.ts';
import { executeWorldAction } from './WorldActions.ts';
export type { BasicActionCommand, BasicActionContext, BasicActionResult } from './ActionContracts.ts';

/**
 * Canonical engine command entry point.
 *
 * Input adapters (entity programs, mouse controls and UI buttons) may use
 * different coordinate systems, but all mutations end up here after converting
 * their target to a canonical world/entity cell.
 */

export const ActionDomain = Object.freeze({
  WORLD: 'world',
  ENTITY: 'entity',
  SELECTION: 'selection',
  QUERY: 'query',
  PHYSICS: 'physics'
});

export function executeBasicAction<const C extends BasicActionCommand>(context: BasicActionContext, command: C): BasicActionResult<C>;
export function executeBasicAction(context: BasicActionContext, command: BasicActionCommand): unknown {
  return dispatchBasicAction(context, command);
}

export function executeBasicActionInput<const C extends BasicActionInput>(context: BasicActionContext, command: C): BasicActionInputResult<C>;
export function executeBasicActionInput(context: BasicActionContext, command: unknown): unknown {
  return dispatchBasicAction(context, command);
}

/** Runtime boundary for untyped messages. Callers must narrow the returned value. */
export function executeUnknownBasicAction(context: BasicActionContext, command: unknown): unknown {
  return dispatchBasicAction(context, command);
}

function dispatchBasicAction(context: BasicActionContext, input: unknown): unknown {
  const command = readRecord(input);
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof command.action !== 'string') {
    return actionResult('unknown', 0, 'invalid_command');
  }
  switch (command.domain) {
    case ActionDomain.WORLD:
      return executeWorldAction(context, command as ActionPayload);
    case ActionDomain.ENTITY:
      return executeEntityAction(context, command);
    case ActionDomain.SELECTION:
      return executeSelectionAction(context, command);
    case ActionDomain.QUERY:
      return executeQueryAction(context, command as ActionPayload);
    case ActionDomain.PHYSICS:
      return executePhysicsAction(context, command as ActionPayload);
    default:
      return actionResult(typeof command.action === 'string' ? command.action : 'unknown', 0, 'unsupported_domain');
  }
}
