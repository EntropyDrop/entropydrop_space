/** Main-site navigation is explicit when Space runs on its own origin. */
export function mainSiteUrl(path: string): string {
  const configured = import.meta.env?.VITE_MAIN_SITE_ORIGIN;
  if (configured) {
    return new URL(path, configured).href;
  }
  if (typeof window !== 'undefined' && (window.location.hostname === 'space.entropydrop.com' || window.location.hostname.endsWith('.entropydrop.com'))) {
    return new URL(path, 'https://entropydrop.com').href;
  }
  return path;
}

export function spaceLoginUrl(): string {
  const destination = typeof window !== 'undefined' ? window.location.href : 'https://space.entropydrop.com/';
  const url = new URL(mainSiteUrl('/space/login'));
  url.searchParams.set('destination', destination);
  return url.href;
}

