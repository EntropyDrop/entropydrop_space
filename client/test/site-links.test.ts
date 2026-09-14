import test from 'node:test';
import assert from 'node:assert/strict';

import { mainSiteUrl, spaceLoginUrl } from '../src/bootstrap/SpaceSiteLinks.ts';

test('mainSiteUrl falls back to https://entropydrop.com on space.entropydrop.com origin', () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const fakeWindow = {
    location: {
      hostname: 'space.entropydrop.com',
      href: 'https://space.entropydrop.com/',
    },
  };
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

  try {
    assert.equal(mainSiteUrl('/space/intro'), 'https://entropydrop.com/space/intro');
    assert.equal(mainSiteUrl('/skin/collection'), 'https://entropydrop.com/skin/collection');
    assert.equal(
      spaceLoginUrl(),
      'https://entropydrop.com/space/login?destination=https%3A%2F%2Fspace.entropydrop.com%2F'
    );
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else delete (globalThis as any).window;
  }
});

test('silent main-site handoff is bounded and strips credentials from the return URL', () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { hostname: 'space.entropydrop.com', href: 'https://space.entropydrop.com/?force_pc=1&token=secret#token=secret&view=world' },
  } });
  try {
    const silent = new URL(spaceLoginUrl({ silent: true }));
    assert.equal(silent.searchParams.get('silent'), '1');
    const destination = new URL(silent.searchParams.get('destination')!);
    assert.equal(destination.searchParams.get('sso_attempted'), '1');
    assert.equal(destination.searchParams.get('force_pc'), '1');
    assert.equal(destination.searchParams.has('token'), false);
    assert.equal(destination.hash, '#view=world');
    assert.equal(new URL(spaceLoginUrl({ reauthenticate: true })).searchParams.get('reauth'), '1');
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else delete (globalThis as any).window;
  }
});
