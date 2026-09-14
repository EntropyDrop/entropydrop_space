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

export function spaceLoginUrl(options: { silent?: boolean; reauthenticate?: boolean } = {}): string {
  const target = mainSiteUrl('/space/login');
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(target, window.location.href);
      if (window.location?.href) {
        const destination = new URL(window.location.href);
        destination.searchParams.delete('token');
        const hash = new URLSearchParams(destination.hash.slice(1));
        hash.delete('token');
        destination.hash = hash.toString();
        if (options.silent) {
          destination.searchParams.set('sso_attempted', '1');
          url.searchParams.set('silent', '1');
        }
        if (options.reauthenticate) url.searchParams.set('reauth', '1');
        url.searchParams.set('destination', destination.href);
      }
      return url.href;
    } catch {
      return target;
    }
  }
  return target;
}
