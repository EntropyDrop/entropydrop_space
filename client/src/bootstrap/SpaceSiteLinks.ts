/** Main-site navigation is explicit when Space runs on its own origin. */
export function mainSiteUrl(path: string): string {
  const configured = import.meta.env?.VITE_MAIN_SITE_ORIGIN;
  return configured ? new URL(path, configured).href : path;
}
export function spaceLoginUrl(): string {
  return mainSiteUrl('/space/login');
}
