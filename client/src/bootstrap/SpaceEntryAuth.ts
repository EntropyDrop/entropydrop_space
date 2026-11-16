import { mainSiteUrl, spaceLoginUrl } from './SpaceSiteLinks.ts';
import { ensureSpaceAccessToken, installSpaceAuthFetchInterceptor } from './SpaceAuthSession.ts';

export interface SpaceEntryAuth {
  apiOrigin: string;
  accountOrigin: string;
  token: string;
}

export type SpaceEntryErrorCode =
  | 'PC_ONLY_REQUIRED'
  | 'BROWSER_UNSUPPORTED'
  | 'LOGIN_REQUIRED'
  | 'WORLD_UNAVAILABLE'
  | 'BOOTSTRAP_FAILED';

export interface SpaceEntryAction {
  label: string;
  url: string;
  secondary?: boolean;
  subtle?: boolean;
}

export class SpaceEntryError extends Error {
  readonly code: SpaceEntryErrorCode;
  readonly actionUrl: string;
  readonly actionLabel: string;
  readonly actions: SpaceEntryAction[];

  constructor(
    code: SpaceEntryErrorCode,
    message: string,
    actionUrl: string,
    actionLabel: string,
    actions?: SpaceEntryAction[]
  ) {
    super(message);
    this.name = 'SpaceEntryError';
    this.code = code;
    this.actionUrl = actionUrl;
    this.actionLabel = actionLabel;
    this.actions = actions && actions.length > 0
      ? actions
      : [{ label: actionLabel, url: actionUrl }];
  }
}

export function isNonPcDevice(
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  platform = typeof navigator !== 'undefined' ? navigator.platform : '',
  maxTouchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
  screenWidth = typeof window !== 'undefined' ? window.innerWidth : 1920,
  screenHeight = typeof window !== 'undefined' ? window.innerHeight : 1080
): boolean {
  const ua = userAgent || '';
  const isMobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS|Windows Phone/i.test(ua);
  const isIPadOS = (platform === 'MacIntel' || ua.includes('Macintosh')) && maxTouchPoints > 1;
  const isTouchScreen = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const isSmallScreen = screenWidth < 1024 || screenHeight < 550;

  return isMobileUa || isIPadOS || Boolean(isTouchScreen && isSmallScreen);
}

export function resolveApiOrigin(configuredBase: string | undefined, pageOrigin: string) {
  const normalized = (configuredBase || '').trim().replace(/\/+$/, '');
  if (!normalized) {
    if (pageOrigin.includes('localhost')) return 'http://localhost:8000';
    if (pageOrigin.includes('space.entropydrop.com') || pageOrigin.includes('entropydrop.com')) {
      return 'https://api.entropydrop.com';
    }
    return pageOrigin;
  }
  return normalized.replace(/\/skin$/, '');
}

export function entryErrorFromResponse(status: number, body: any) {
  const detail = body?.detail;
  if (status === 401 || (status === 403 && detail?.code === 'ACCOUNT_LOGIN_REQUIRED')) {
    return new SpaceEntryError(
      'LOGIN_REQUIRED',
      'Please log in to EntropyDrop before entering Space.',
      spaceLoginUrl({ reauthenticate: true }),
      'Log In',
      [
        { label: 'Sign in on main site', url: spaceLoginUrl({ reauthenticate: true }) },
        { label: 'Back to Main Site', url: mainSiteUrl('/space/intro'), secondary: true }
      ]
    );
  }
  if (status === 404 && detail?.code === 'WORLD_NOT_FOUND') {
    return new SpaceEntryError(
      'WORLD_UNAVAILABLE',
      'The selected world was not found or is unavailable on this server. Please choose another world.',
      mainSiteUrl('/space/intro'),
      'Choose World'
    );
  }
  return new SpaceEntryError(
    'BOOTSTRAP_FAILED',
    typeof detail === 'string'
      ? detail
      : 'Could not load Space player profile. Please try again later.',
    window.location.href,
    'Retry',
    [
      { label: 'Retry', url: window.location.href },
      { label: 'Back to Main Site', url: mainSiteUrl('/space/intro'), secondary: true }
    ]
  );
}

export async function authenticateSpace(reportProgress?: (value: number, message: string) => void): Promise<SpaceEntryAuth | null> {
  const accountOrigin = resolveApiOrigin(import.meta.env?.VITE_API_BASE_URL, window.location.origin);
  const apiOrigin = resolveApiOrigin(import.meta.env?.VITE_SPACE_API_BASE_URL || accountOrigin, window.location.origin);
  installSpaceAuthFetchInterceptor(accountOrigin, apiOrigin);
  reportProgress?.(14, 'Verifying EntropyDrop account…');
  const token = await ensureSpaceAccessToken(accountOrigin);
  if (!token) {
    // Only another origin can have a main-site-only localStorage session. On a
    // same-origin development site it is already shared, so silent handoff is
    // redundant and can loop when the login page normalizes its destination.
    const silentLogin = new URL(spaceLoginUrl({ silent: true }), window.location.href);
    if (silentLogin.origin !== window.location.origin
      && !new URL(window.location.href).searchParams.has('sso_attempted')) {
      window.location.replace(silentLogin.href);
      return null;
    }
    throw entryErrorFromResponse(401, null);
  }

  return { apiOrigin, accountOrigin, token };
}

export function createEntryProgressReporter(): (value: number, message: string) => void {
  const status = document.getElementById('space-entry-status');
  const progress = document.getElementById('space-entry-progress');
  const progressFill = document.getElementById('space-entry-progress-fill') as HTMLElement | null;
  const progressValue = document.getElementById('space-entry-progress-value');
  return (value, message) => {
    const normalized = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (status) status.textContent = message;
    if (progress) {
      progress.hidden = false;
      progress.classList.remove('failed');
      progress.removeAttribute('aria-invalid');
      progress.setAttribute('aria-valuenow', String(normalized));
      progress.setAttribute('aria-valuetext', `${message} ${normalized}%`);
    }
    if (progressFill) progressFill.style.width = `${normalized}%`;
    if (progressValue) progressValue.textContent = `${normalized}%`;
  };
}

export function renderEntryError(error: unknown) {
  const entryError = error instanceof SpaceEntryError
    ? error
    : new SpaceEntryError(
        'BOOTSTRAP_FAILED',
        'Space initialization failed. Please check your network and try again.',
        window.location.href,
        'Retry',
        [
          { label: 'Retry', url: window.location.href },
          { label: 'Back to Main Site', url: mainSiteUrl('/space/intro'), secondary: true }
        ]
      );
  const gate = document.getElementById('space-entry-gate');
  const status = document.getElementById('space-entry-status');
  const actionContainer = document.getElementById('space-entry-actions');
  const action = document.getElementById('space-entry-action') as HTMLAnchorElement | null;
  const progress = document.getElementById('space-entry-progress');
  if (gate) gate.hidden = false;
  if (status) status.textContent = entryError.message;
  if (progress) {
    progress.hidden = true;
    progress.classList.add('failed');
    progress.setAttribute('aria-invalid', 'true');
    progress.setAttribute('aria-valuetext', entryError.message);
  }
  if (actionContainer) {
    actionContainer.innerHTML = '';
    if (entryError.code === 'LOGIN_REQUIRED') {
      const login = document.createElement('div');
      login.className = 'space-google-login';
      actionContainer.appendChild(login);
      const accountOrigin = resolveApiOrigin(import.meta.env?.VITE_API_BASE_URL, window.location.origin);
      void import('./SpaceGoogleLogin.ts').then(({ mountSpaceGoogleLogin }) => {
        if (login.isConnected) return mountSpaceGoogleLogin(login, accountOrigin);
      }).catch(error => console.warn('Could not load Google sign-in.', error));
    }
    for (const act of entryError.actions) {
      const a = document.createElement('a');
      a.className = [
        'space-entry-action',
        act.secondary ? 'secondary' : '',
        act.subtle ? 'subtle' : '',
      ].filter(Boolean).join(' ');
      a.href = act.url;
      a.textContent = act.label;
      actionContainer.appendChild(a);
    }
  } else if (action) {
    action.href = entryError.actionUrl;
    action.textContent = entryError.actionLabel;
    action.hidden = false;
  }
}

export function checkSpaceDevice(): void {
  const url = new URL(window.location.href);
  const forcePc = import.meta.env?.DEV && (url.searchParams.get('force_pc') === '1' || url.searchParams.get('force') === '1');
  const overview = mainSiteUrl('/space/intro');
  if (isNonPcDevice() && !forcePc) {
    if (import.meta.env?.DEV) url.searchParams.set('force_pc', '1');
    throw new SpaceEntryError(
      'PC_ONLY_REQUIRED',
      'Open Space on a desktop browser with WebGPU, a keyboard, and a mouse.',
      overview,
      'Back to Space Overview',
      [
        { label: 'Back to Space Overview', url: overview },
        ...(import.meta.env?.DEV ? [{ label: 'Try Anyway (Dev)', url: url.href, secondary: true }] : []),
      ],
    );
  }
  if (!navigator.gpu || typeof document.body.requestPointerLock !== 'function') {
    throw new SpaceEntryError(
      'BROWSER_UNSUPPORTED',
      'This browser does not provide WebGPU or pointer lock. Try a supported desktop browser with graphics acceleration enabled.',
      overview,
      'Back to Space Overview',
    );
  }
}
