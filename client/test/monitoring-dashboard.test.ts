import test from 'node:test';
import assert from 'node:assert/strict';
import { isMonitoringRoute } from '../src/bootstrap/MonitoringRoute.ts';
import { spaceUiStore } from '../src/ui/react/store/SpaceUiStore.ts';

test('isMonitoringRoute correctly identifies monitoring URL paths and query parameters', () => {
  const originalWindow = globalThis.window;

  try {
    // 1. Path /admin/monitoring
    (globalThis as any).window = {
      location: new URL('https://space.entropydrop.com/admin/monitoring'),
    };
    assert.equal(isMonitoringRoute(), true);

    // 2. Path /monitor
    (globalThis as any).window = {
      location: new URL('https://space.entropydrop.com/monitor'),
    };
    assert.equal(isMonitoringRoute(), true);

    // 3. Query ?admin=monitoring
    (globalThis as any).window = {
      location: new URL('https://space.entropydrop.com/?admin=monitoring'),
    };
    assert.equal(isMonitoringRoute(), true);

    // 4. Query ?page=monitoring
    (globalThis as any).window = {
      location: new URL('http://localhost:5173/?page=monitoring'),
    };
    assert.equal(isMonitoringRoute(), true);

    // 5. Hash #/monitoring
    (globalThis as any).window = {
      location: new URL('http://localhost:5173/#/monitoring'),
    };
    assert.equal(isMonitoringRoute(), true);

    // 6. Normal game root path
    (globalThis as any).window = {
      location: new URL('https://space.entropydrop.com/'),
    };
    assert.equal(isMonitoringRoute(), false);

    // 7. Normal game app path
    (globalThis as any).window = {
      location: new URL('https://space.entropydrop.com/space/app/'),
    };
    assert.equal(isMonitoringRoute(), false);
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('SpaceUiStore toggleAdminMonitoring opens and closes monitoring modal', () => {
  spaceUiStore.closeAllModals(true);
  assert.equal(spaceUiStore.getSnapshot().activeModal, null);

  spaceUiStore.toggleAdminMonitoring(true);
  assert.equal(spaceUiStore.getSnapshot().activeModal, 'monitoring');

  spaceUiStore.toggleAdminMonitoring(false);
  assert.equal(spaceUiStore.getSnapshot().activeModal, null);
});

test('SpaceUiStore isAdmin defaults to false and guards non-admin users', () => {
  // 1. Initial state is false
  spaceUiStore.setAuthenticatedSession('http://localhost:8000', 'test-token', false);
  assert.equal(spaceUiStore.getSnapshot().isAdmin, false);

  // 2. Explicit admin state
  spaceUiStore.setAuthenticatedSession('http://localhost:8000', 'test-token', true);
  assert.equal(spaceUiStore.getSnapshot().isAdmin, true);

  // 3. Reset back to non-admin
  spaceUiStore.setAuthenticatedSession('http://localhost:8000', 'test-token', false);
  assert.equal(spaceUiStore.getSnapshot().isAdmin, false);
});

