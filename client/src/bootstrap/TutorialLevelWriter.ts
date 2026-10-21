import type { TutorialLevel } from '../tutorial/TutorialLevelFormat.ts';

/** Imported only by the local development authoring entry. */
export async function writeTutorialLevel(level: TutorialLevel): Promise<void> {
  const response = await fetch(`${import.meta.env.BASE_URL}__dev/tutorial-level`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(level),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.saved !== true) {
    throw new Error(result?.error || 'The local development server could not save the tutorial.');
  }
}
