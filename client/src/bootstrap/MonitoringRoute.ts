/**
 * Helper to determine if the current URL target represents the admin monitoring page.
 */
export function isMonitoringRoute(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const url = new URL(window.location.href);
    const path = url.pathname.toLowerCase();
    const search = url.search.toLowerCase();
    const hash = url.hash.toLowerCase();
    return (
      path.endsWith('/monitoring') ||
      path.endsWith('/monitor') ||
      path.includes('/admin/monitoring') ||
      search.includes('admin=monitoring') ||
      search.includes('page=monitoring') ||
      search.includes('view=monitoring') ||
      hash === '#/monitoring' ||
      hash === '#monitoring'
    );
  } catch {
    return false;
  }
}
