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

test('logged-out players are prompted to log in and no offline mode is offered', async t => {
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
  const fakeWindow = {
    innerWidth: 1280,
    innerHeight: 720,
    localStorage: storage,
    location: {
      href: 'http://localhost:5173/space/app/',
      origin: 'http://localhost:5173',
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

  const actions = elements.get('space-entry-actions')!.children;
  assert.deepEqual(
    actions.map(action => ({ href: action.href, className: action.className })),
    [
      { href: '/skin/', className: 'space-entry-action' },
      { href: '/space/intro', className: 'space-entry-action secondary' },
    ]
  );
});
