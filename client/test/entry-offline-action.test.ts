import test from 'node:test';
import assert from 'node:assert/strict';

import { enterSpace } from '../src/bootstrap/SpaceBootstrap.ts';

class FakeElement {
  hidden = false;
  textContent = '';
  className = '';
  href = '';
  style = { width: '' };
  children: FakeElement[] = [];
  private attributes = new Map<string, string>();
  private classes = new Set<string>();

  readonly classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
  };

  set innerHTML(value: string) {
    if (value === '') this.children = [];
  }

  get innerHTML() {
    return '';
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }
}

function replaceGlobal(name: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete (globalThis as any)[name];
  };
}

for (const crossOrigin of [false, true]) {
for (const afterHandoff of [false, true]) {
test(`logged-out ${crossOrigin ? 'separate-origin' : 'same-origin'} entry ${afterHandoff ? 'offers Google login after handoff' : 'checks only relevant sessions'}`, async t => {
  const elements = new Map([
    ['space-entry-gate', new FakeElement()],
    ['space-entry-status', new FakeElement()],
    ['space-entry-actions', new FakeElement()],
    ['space-entry-action', new FakeElement()],
    ['space-entry-progress', new FakeElement()],
    ['space-entry-progress-fill', new FakeElement()],
    ['space-entry-progress-value', new FakeElement()],
  ]);
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  let redirected = '';
  const pageOrigin = crossOrigin ? 'https://space.entropydrop.com' : 'http://localhost:5173';
  const mainOrigin = crossOrigin ? 'https://entropydrop.com' : pageOrigin;
  const pageUrl = `${pageOrigin}/space/app/${afterHandoff ? '?sso_attempted=1' : ''}`;
  const fakeWindow = {
    innerWidth: 1280,
    innerHeight: 720,
    localStorage: storage,
    location: {
      href: pageUrl,
      replace: (url: string) => { redirected = url; },
      origin: pageOrigin,
      hostname: new URL(pageUrl).hostname,
      pathname: '/space/app/',
      search: '',
    },
    matchMedia: () => ({ matches: false }),
    fetch: async () => new Response(null, { status: 401 }),
    dispatchEvent: () => true,
  };
  const fakeDocument = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
  };

  const restoreWindow = replaceGlobal('window', fakeWindow);
  const restoreDocument = replaceGlobal('document', fakeDocument);
  const restoreStorage = replaceGlobal('localStorage', storage);
  t.after(() => {
    restoreStorage();
    restoreDocument();
    restoreWindow();
  });

  await enterSpace(() => {
    assert.fail('the game must not start without an authenticated session');
  });

  if (crossOrigin && !afterHandoff) {
    const login = new URL(redirected);
    assert.equal(login.pathname, '/space/login');
    assert.equal(login.origin, mainOrigin);
    assert.equal(login.searchParams.get('silent'), '1');
    assert.equal(new URL(login.searchParams.get('destination')!).searchParams.get('sso_attempted'), '1');
    return;
  }
  assert.equal(redirected, '');
  assert.equal(elements.get('space-entry-progress')!.hidden, true);
  const actions = elements.get('space-entry-actions')!.children;
  assert.equal(actions[0].className, 'space-google-login');
  assert.deepEqual(
    actions.slice(1).map(action => ({ href: action.href, className: action.className })),
    [
      { href: `${mainOrigin}/space/login?reauth=1&destination=${encodeURIComponent(pageUrl)}`, className: 'space-entry-action' },
      { href: crossOrigin ? `${mainOrigin}/space/intro` : '/space/intro', className: 'space-entry-action secondary' },
    ]
  );
});

}
}
