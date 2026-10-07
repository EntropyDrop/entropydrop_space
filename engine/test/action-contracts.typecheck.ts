import { executeBasicAction, executeBasicActionInput } from '../src/actions/BasicActions.ts';
import type { BasicActionContext } from '../src/actions/ActionContracts.ts';

// Compile-only: these assertions run with the engine's normal strict typecheck.
export function checkActionContracts(context: BasicActionContext, payload: unknown) {
  // @ts-expect-error Query operations cannot be sent to the world mutation domain.
  executeBasicAction(context, { domain: 'world', action: 'raycast', origin: [0, 0, 0], direction: [0, 1, 0] });
  // @ts-expect-error Placement requires a cell or position.
  executeBasicAction(context, { domain: 'entity', action: 'place-standard' });
  // @ts-expect-error The typed UI boundary cannot accept an unchecked payload.
  executeBasicAction(context, { domain: 'physics', action: 'set-body-mass', mass: payload });
  // @ts-expect-error Body type is a finite union.
  executeBasicAction(context, { domain: 'physics', action: 'set-body-type', bodyType: 'static' });

  const placed = executeBasicAction(context, { domain: 'world', action: 'place-standard', cell: [0, 1, 0] });
  const amount: number | undefined = placed.placed;
  // @ts-expect-error Mutation results are not raycast hits or any.
  placed.entityHit;
  const queried = executeBasicAction(context, { domain: 'query', action: 'raycast', origin: [0, 0, 0], direction: [0, 1, 0] });
  // @ts-expect-error Raycast results require their own shape.
  queried.placed;

  // The script adapter validates untrusted values and still preserves result types.
  const script = executeBasicActionInput(context, { domain: 'physics', action: 'set-body-mass', mass: payload });
  const mass: number | null | undefined = script.mass;
  // @ts-expect-error Unknown operation names cannot bypass the script adapter.
  executeBasicActionInput(context, { domain: 'physics', action: 'set-everything', mass: payload });
  return { amount, mass };
}
