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
