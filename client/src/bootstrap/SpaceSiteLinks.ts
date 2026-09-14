/** Main-site navigation is explicit when Space runs on its own origin. */
export function mainSiteUrl(path: string): string {
  const configured = import.meta.env?.VITE_MAIN_SITE_ORIGIN;
  if (configured) {
    return new URL(path, configured).href;
  }
  const hostname = typeof window !== 'undefined' ? window.location?.hostname : '';
  if (hostname && (hostname === 'space.entropydrop.com' || hostname.endsWith('.entropydrop.com'))) {
    return new URL(path, 'https://entropydrop.com').href;
  }
  return path;
}

export function spaceLoginUrl(): string {
  const target = mainSiteUrl('/space/login');
  if (typeof window !== 'undefined' && target.startsWith('http')) {
    try {
      const url = new URL(target);
      if (window.location?.href) {
        url.searchParams.set('destination', window.location.href);
      }
      return url.href;
    } catch {
      return target;
    }
  }
  return target;
}

