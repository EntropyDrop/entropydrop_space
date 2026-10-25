import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBasicMaterial } from 'three';
import { trackRenderObjectLifetime } from '../src/engine/render/RenderObjectLifetime.ts';

test('closing preview renderers detaches shared material listeners before clearing node state', () => {
  const material = new MeshBasicMaterial();
  const makeRenderer = () => {
    const states = new Map<object, number>();
    let retired = 0;
    const objects = { createRenderObject() {
      const object = {
        onDispose() {
          assert.ok(states.has(object), 'node state must still exist during object retirement');
          states.delete(object);
          retired++;
        },
        dispose() { material.removeEventListener('dispose', dispose); object.onDispose(); },
      };
      const dispose = () => object.dispose();
      material.addEventListener('dispose', dispose);
      states.set(object, 1);
      return object;
    } };
    const retire = trackRenderObjectLifetime(objects);
    objects.createRenderObject();
    return { states, retire, retired: () => retired };
  };
  const world = makeRenderer();
  for (let i = 0; i < 3; i++) {
    const preview = makeRenderer();
    preview.retire();
    preview.states.clear(); // Three.Renderer.dispose()
    preview.retire(); // repeated teardown must be harmless
    assert.equal(preview.retired(), 1);
  }
  assert.equal(world.retired(), 0, 'closing a preview does not dispose shared world materials');
  material.dispose(); // installation rebuilds the car after the editor was reopened
  assert.equal(world.retired(), 1);
  world.retire();
  assert.equal(world.retired(), 1);
});
