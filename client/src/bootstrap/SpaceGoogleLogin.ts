import { readJsonResponse } from './NetworkSafety.ts';

interface GoogleIdentity {
  initialize(options: { client_id: string; callback: (response: { credential?: string }) => void }): void;
  renderButton(container: HTMLElement, options: { theme: string; size: string; text: string; shape: string }): void;
}

const identity = () => (window as Window & { google?: { accounts?: { id?: GoogleIdentity } } }).google?.accounts?.id;
let sdkPromise: Promise<GoogleIdentity> | null = null;

function loadGoogleIdentity(): Promise<GoogleIdentity> {
  const existing = identity();
  if (existing) return Promise.resolve(existing);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => fail(), 10_000);
    const fail = () => {
      window.clearTimeout(timeout);
      script.remove();
      sdkPromise = null;
      reject(new Error('Google sign-in could not load.'));
    };
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onerror = fail;
    script.onload = () => {
      const google = identity();
      if (!google) return fail();
      window.clearTimeout(timeout);
      resolve(google);
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export async function signInToSpaceWithGoogle(
  apiOrigin: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
  storage: Pick<Storage, 'setItem'> = localStorage,
): Promise<string> {
  const response = await fetchImpl(`${new URL(apiOrigin).origin}/api/auth/google`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ token: credential }),
  });
  if (!response.ok) throw new Error('Google login failed. Please try again.');
  const data = await readJsonResponse<{ access_token?: string }>(response, 64 * 1024);
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Invalid login response.');
  storage.setItem('token', data.access_token);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('auth-token-updated'));
  return data.access_token;
}

/** Uses the same Google client and account API as the main site. */
export async function mountSpaceGoogleLogin(container: HTMLElement, apiOrigin: string): Promise<void> {
  const button = document.createElement('div');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading Google sign-in…';
  container.append(button, status);
  try {
    let clientId = import.meta.env?.VITE_GOOGLE_CLIENT_ID;
    if (!clientId) {
      const response = await fetch(`${new URL(apiOrigin).origin}/api/auth/config`, {
        cache: 'no-store', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Account configuration unavailable.');
      const config = await readJsonResponse<{ google_client_id?: string }>(response, 4096);
      clientId = config.google_client_id;
    }
    if (!clientId) throw new Error('Google login is not configured.');
    const google = await loadGoogleIdentity();
    if (!container.isConnected) return;
    let signingIn = false;
    google.initialize({
      client_id: clientId,
      callback: ({ credential }) => {
        if (!credential || signingIn) return;
        signingIn = true;
        button.hidden = true;
        status.textContent = 'Signing in and entering Space…';
        void signInToSpaceWithGoogle(apiOrigin, credential).then(() => {
          window.location.reload();
        }).catch(() => {
          signingIn = false;
          button.hidden = false;
          status.textContent = 'Sign-in failed. Retry or sign in on the main site.';
        });
      },
    });
    google.renderButton(button, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular' });
    status.textContent = '';
  } catch {
    status.textContent = 'Google sign-in is unavailable. Use the main-site sign-in below.';
  }
}
