/** Selected by Vite's offline build mode, never by a URL or browser setting. */
export const SPACE_OFFLINE_BUILD = import.meta.env?.VITE_SPACE_OFFLINE === '1';

/** A fresh page gives tutorial sessions no authenticated runtime to inherit. */
export function isTutorialRoute(search: string): boolean {
  return new URLSearchParams(search).get('tutorial') === '1';
}

export const SPACE_TUTORIAL = typeof window !== 'undefined' && isTutorialRoute(window.location?.search || '');
export const SPACE_LOCAL_SESSION = SPACE_OFFLINE_BUILD || SPACE_TUTORIAL;

export function isLocalTutorialHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

/** Published builds never expose the development server's source-file writer. */
export const SPACE_TUTORIAL_AUTHORING = Boolean(import.meta.env?.DEV) && SPACE_TUTORIAL
  && typeof window !== 'undefined' && isLocalTutorialHost(window.location.hostname);

// Server capability/worker/core checks remain authoritative in online builds.
export const SPACE_HOSTING_UI_ENABLED = !SPACE_LOCAL_SESSION;
