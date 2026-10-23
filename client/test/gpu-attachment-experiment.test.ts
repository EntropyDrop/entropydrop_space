import test from 'node:test';
import assert from 'node:assert/strict';
import { installTransientFrameAttachments } from '../src/dev/GpuAttachmentExperiment.ts';

test('attachment experiment preserves resolve output and excludes shadows, sampled depth and load passes', () => {
  const color = { storeOp: 'store', resolveTarget: {} }, depth = { depthStoreOp: 'store' };
  const descriptor = { colorAttachments: [color], depthStencilAttachment: depth };
  const target = { samples: 4, depthTexture: null as object | null };
  const backend = { isWebGPUBackend: true, _getRenderPassDescriptor(_context: any) { return descriptor; } };
  const original = backend._getRenderPassDescriptor;
  const renderer = { backend, _frameBufferTarget: target, autoClear: true, autoClearColor: true, autoClearDepth: true };
  let mode = 3;
  const restore = installTransientFrameAttachments(renderer, () => mode);
  assert.ok(restore);
  const context = { renderTarget: target, clearColor: true, clearDepth: true };
  backend._getRenderPassDescriptor(context); color.storeOp = 'store'; depth.depthStoreOp = 'store';
  assert.equal(color.storeOp, 'discard'); assert.equal(depth.depthStoreOp, 'discard'); assert.ok(color.resolveTarget);
  target.depthTexture = {}; backend._getRenderPassDescriptor(context);
  assert.equal(color.storeOp, 'store'); assert.equal(depth.depthStoreOp, 'store');
  target.depthTexture = null; context.clearDepth = false; backend._getRenderPassDescriptor(context);
  assert.equal(depth.depthStoreOp, 'store');
  context.clearDepth = true; backend._getRenderPassDescriptor({ ...context, renderTarget: {} });
  assert.equal(color.storeOp, 'store');
  mode = 1; backend._getRenderPassDescriptor(context);
  assert.equal(color.storeOp, 'discard'); assert.equal(depth.depthStoreOp, 'store');
  restore(); assert.equal(backend._getRenderPassDescriptor, original);
  assert.equal(color.storeOp, 'store'); assert.equal(depth.depthStoreOp, 'store');
  assert.equal(Object.getOwnPropertyDescriptor(color, 'storeOp')?.get, undefined);
});

test('color-only disposal keeps depth, single-sample outputs, load passes and unresolved colors intact', () => {
  const color = { storeOp: 'store', resolveTarget: {} as object | null };
  const depth = { depthStoreOp: 'store' };
  const target = { samples: 4, depthTexture: null };
  const backend = { isWebGPUBackend: true, _getRenderPassDescriptor(_context: any) {
    return { colorAttachments: [color], depthStencilAttachment: depth };
  } };
  const renderer = { backend, _frameBufferTarget: target, autoClear: true, autoClearColor: true, autoClearDepth: true };
  const context = { renderTarget: target, clearColor: true, clearDepth: true };
  let enabled = true;
  const restore = installTransientFrameAttachments(renderer, () => enabled ? 1 : 0);
  assert.ok(restore);
  const observe = () => {
    backend._getRenderPassDescriptor(context);
    // Three writes these fields after obtaining its cached descriptor.
    color.storeOp = 'store'; depth.depthStoreOp = 'store';
    assert.equal(depth.depthStoreOp, 'store');
    return color.storeOp;
  };
  assert.equal(observe(), 'discard');
  target.samples = 1; assert.equal(observe(), 'store'); target.samples = 4;
  context.clearColor = false; assert.equal(observe(), 'store'); context.clearColor = true;
  renderer.autoClear = false; assert.equal(observe(), 'store'); renderer.autoClear = true;
  color.resolveTarget = null; assert.equal(observe(), 'store'); color.resolveTarget = {};
  enabled = false; assert.equal(observe(), 'store');
  enabled = true; assert.equal(observe(), 'discard');
  restore(); assert.equal(color.storeOp, 'store');
  assert.equal(installTransientFrameAttachments({ backend: {} }, () => 1), false);
});
