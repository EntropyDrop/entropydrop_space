import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGpuIntervals, GpuFrameTimeline } from '../src/dev/GpuFrameTimeline.ts';
import { guardTimestampWrites } from '../src/dev/FrameDiagnostics.ts';

test('GPU timeline separates overlap and uncovered intervals without calling either GPU busy time', () => {
  const origin = 987654321000000n;
  const result = describeGpuIntervals(new BigUint64Array([0n, 3000000n, 1000000n, 3500000n, 4000000n, 4500000n].map(v => v + origin)))!;
  assert.equal(result.spanMs, 4.5); assert.equal(result.overlapMs, 2); assert.equal(result.uncoveredMs, .5);
  assert.deepEqual(result.intervals[1], { startMs: 1, endMs: 3.5, durationMs: 2.5 });
  assert.equal(describeGpuIntervals(new BigUint64Array()), null);
  assert.throws(() => describeGpuIntervals(new BigUint64Array([4n, 0n])), /reversed/);
});

test('timestamp guard clears cached writes on unsampled frames and after closing', () => {
  const backend = { trackTimestamp: true, initTimestampQuery(_type: string, _id: string, descriptor: any) {
    if (this.trackTimestamp) descriptor.timestampWrites = { querySet: 42 };
  } };
  const original = backend.initTimestampQuery, restore = guardTimestampWrites(backend), descriptor: any = {};
  backend.initTimestampQuery('render', 'r:0:f1', descriptor); assert.ok(descriptor.timestampWrites);
  backend.trackTimestamp = false;
  backend.initTimestampQuery('render', 'r:0:f2', descriptor); assert.equal(descriptor.timestampWrites, undefined);
  backend.trackTimestamp = true;
  backend.initTimestampQuery('render', 'r:0:f3', descriptor); restore();
  assert.equal(backend.initTimestampQuery, original); assert.equal(descriptor.timestampWrites, undefined);
});

test('independent queries own render/compute slots, map only written bytes, and restore methods', async () => {
  const previousUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
  const previousMap = Object.getOwnPropertyDescriptor(globalThis, 'GPUMapMode');
  Object.defineProperty(globalThis, 'GPUBufferUsage', { configurable: true, value: { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 } });
  Object.defineProperty(globalThis, 'GPUMapMode', { configurable: true, value: { READ: 1 } });
  const buffers: any[] = [], descriptors: any[] = [], query = { destroy() {} };
  const device = {
    createQuerySet() { return query; },
    createBuffer({ size }: any) {
      const buffer = { mapState: 'unmapped', mappedSize: 0, destroyed: false,
        async mapAsync(_mode: number, _offset: number, bytes: number) { this.mapState = 'mapped'; this.mappedSize = bytes; },
        getMappedRange(offset?: number, bytes?: number) {
          assert.equal(offset, 0); assert.equal(bytes, this.mappedSize); assert.ok(bytes! < size);
          return new BigUint64Array([1000000n, 3000000n, 2000000n, 4000000n]).buffer;
        }, unmap() { this.mapState = 'unmapped'; }, destroy() { this.destroyed = true; } };
      buffers.push(buffer); return buffer;
    },
    createCommandEncoder() { return {
      beginRenderPass(descriptor: any) { descriptors.push(descriptor); },
      beginComputePass(descriptor: any) { descriptors.push(descriptor); },
      resolveQuerySet(_query: any, _first: number, count: number) { assert.equal(count, 4); },
      copyBufferToBuffer() {}, finish() { return {}; },
    }; },
    queue: { submit() {}, writeBuffer() {}, writeTexture() {}, copyExternalImageToTexture() {} },
  };
  const original = device.createCommandEncoder, timer = new GpuFrameTimeline(device);
  try {
    const stale = { timestampWrites: { querySet: 'old' } };
    device.createCommandEncoder().beginRenderPass(stale);
    assert.equal(descriptors[0].timestampWrites, undefined); assert.equal(stale.timestampWrites.querySet, 'old');
    timer.begin();
    const encoder = device.createCommandEncoder(); encoder.beginRenderPass(stale); encoder.beginComputePass({});
    const row = (await timer.end())!;
    assert.equal(row.spanMs, 3); assert.equal(row.staleWrites, 1);
    assert.deepEqual(row.passes.map(p => p.kind), ['render', 'compute']);
    assert.equal(descriptors[1].timestampWrites.querySet, query);
    assert.equal(descriptors[2].timestampWrites.beginningOfPassWriteIndex, 2);
    timer.dispose(); assert.equal(device.createCommandEncoder, original);
    assert.ok(buffers.every(b => b.destroyed && b.mapState === 'unmapped'));
  } finally {
    if (previousUsage) Object.defineProperty(globalThis, 'GPUBufferUsage', previousUsage); else delete (globalThis as any).GPUBufferUsage;
    if (previousMap) Object.defineProperty(globalThis, 'GPUMapMode', previousMap); else delete (globalThis as any).GPUMapMode;
  }
});
