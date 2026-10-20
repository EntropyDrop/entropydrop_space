/** Selected by Vite's offline build mode, never by a URL or browser setting. */
export const SPACE_OFFLINE_BUILD = import.meta.env?.VITE_SPACE_OFFLINE === '1';

// Server capability/worker/core checks remain authoritative in online builds.
export const SPACE_HOSTING_UI_ENABLED = !SPACE_OFFLINE_BUILD;
