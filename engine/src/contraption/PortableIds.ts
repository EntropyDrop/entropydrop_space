import { MAX_COMPONENT_ID_LENGTH } from '../constants/SpaceConstants.ts';

const COMPONENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Shared format for component and constraint ids. */
export function isValidPortableId(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_COMPONENT_ID_LENGTH) return false;
  return COMPONENT_ID_PATTERN.test(value);
}

/** Constraint ids live in their own namespace. */
export function isValidConstraintId(value: unknown): boolean {
  return isValidPortableId(value);
}

/** Component ids are portable identities. Hierarchy and external constraint
 * endpoints are represented structurally, so no string is reserved. */
export function isValidComponentId(value: unknown): boolean {
  return isValidPortableId(value);
}
