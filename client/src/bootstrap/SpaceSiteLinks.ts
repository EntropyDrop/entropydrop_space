/** Offline distribution links always leave the embedded game for the online Space. */
export type OnlineSpacePanel = 'market' | 'agent-build' | 'api-keys' | 'character' | 'worlds' | 'hosting';

export function onlineSpaceUrl(panel?: OnlineSpacePanel): string {
  const url = new URL('https://space.entropydrop.com/');
  if (panel) url.searchParams.set('panel', panel);
  return url.href;
}

export function onlinePanelSettingsTab(panel: string | null): 'character' | 'graphics' | 'api' | null {
  if (panel === 'api-keys' || panel === 'hosting') return 'api';
  if (panel === 'character') return 'character';
  if (panel === 'worlds') return 'graphics';
  return null;
}

export const ONLINE_SPACE_FEATURES = {
  market: { title: 'Community Market', panel: 'market', action: 'Open Online Market',
    description: 'Browse, download, like and share community creations in Space Online.' },
  publish: { title: 'Publish to Market Online', panel: 'market', action: 'Open Market to Publish',
    description: 'Publishing requires an online account. Export this item or color set as Protobuf, then import it into your online backpack to publish it. Opening Space Online does not upload anything automatically.' },
  'agent-build': { title: 'Agent Build', panel: 'agent-build', action: 'Build with an Agent Online',
    description: 'Connect your coding agent to Space Online to build and program entities with natural language.' },
  'api-keys': { title: 'API Keys & Account Usage', panel: 'api-keys', action: 'Manage API Keys Online',
    description: 'Create, view and revoke Space API keys, check credits and API allowances, and connect external agents in Space Online. This offline edition does not connect to your account.' },
  'ai-assistant': { title: 'AI Assistant Online', panel: 'agent-build', action: 'Open AI Tools Online',
    description: 'Model API keys, model discovery and AI chat require an online connection. Use Space Online for AI assistance. You can still edit, compile and run entity scripts locally in this offline edition.' },
  hosting: { title: 'Server Hosting Online', panel: 'hosting', action: 'Open Server Hosting Online',
    description: 'Run entities on a server after you leave the game in Space Online. Copy your offline entity to the backpack and export it as Protobuf, then import and place it in an online world to host it.' },
  character: { title: 'Your Online Character', panel: 'character', action: 'Customize Character Online',
    description: 'This offline edition uses the included character skin. Sign in to Space Online to select, upload or generate your own skins.' },
  worlds: { title: 'Shared Worlds Online', panel: 'worlds', action: 'Explore Shared Worlds Online',
    description: 'Multiplayer, shared world saves, distant server snapshots and chain-linked worlds are available in Space Online. This edition generates nearby terrain locally.' },
} as const satisfies Record<string, { title: string; panel: OnlineSpacePanel; action: string; description: string }>;

export type OnlineSpaceFeature = keyof typeof ONLINE_SPACE_FEATURES;

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
