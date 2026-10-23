/** Offline diagnostic: independent timestamp ownership and queue attribution.
 * Pass envelopes include dependencies and overlap; they are not GPU busy counters. */
import { interceptMethod } from './FrameDiagnostics.ts';
import { gpuTimestampSpan } from './GpuTimestampSpan.ts';

export function describeGpuIntervals(times: BigUint64Array) {
  const span = gpuTimestampSpan(times);
  if (!span) return null;
  const first = times.reduce((a, b) => a < b ? a : b);
  const intervals = Array.from({ length: times.length / 2 }, (_, i) => ({
    startMs: Number(times[i * 2] - first) / 1e6, endMs: Number(times[i * 2 + 1] - first) / 1e6,
    durationMs: Number(times[i * 2 + 1] - times[i * 2]) / 1e6,
  }));
  let end = 0, covered = 0;
  for (const interval of [...intervals].sort((a, b) => a.startMs - b.startMs)) {
    covered += Math.max(0, interval.endMs - Math.max(end, interval.startMs));
    end = Math.max(end, interval.endMs);
  }
  return { ...span, intervals, uncoveredMs: span.spanMs - covered,
    overlapMs: span.passSumMs - covered };
}

export class GpuFrameTimeline {
  private undo: (() => void)[] = [];
  private query: any;
  private resolve: any;
  private read: any;
  private active = false;
  private busy = false;
  private start = 0;
  private passes: any[] = [];
  private events: any[] = [];
  private staleWrites = 0;
  private createEncoder: any;
  private device: any;
  private wallTimeMs = 0;
  constructor(device: any) {
    this.device = device;
    const usage = (globalThis as any).GPUBufferUsage;
    this.query = device.createQuerySet({ type: 'timestamp', count: 128, label: 'offline-frame-timeline' });
    this.resolve = device.createBuffer({ size: 1024, usage: usage.QUERY_RESOLVE | usage.COPY_SRC });
    this.read = device.createBuffer({ size: 1024, usage: usage.MAP_READ | usage.COPY_DST });
    this.createEncoder = device.createCommandEncoder.bind(device);
    this.undo.push(interceptMethod(device, 'createCommandEncoder', (original, args) => {
      const encoder = original(...args), label = args[0]?.label ?? '';
      for (const method of ['beginRenderPass', 'beginComputePass']) interceptMethod(encoder, method, (begin, passArgs) => {
        const descriptor = { ...passArgs[0] };
        // r183 caches render-pass descriptors. Turning trackTimestamp off does
        // not remove their previous timestampWrites; own and clear them here.
        if (descriptor.timestampWrites) this.staleWrites++;
        delete descriptor.timestampWrites;
        if (this.active) {
          const index = this.passes.length;
          if (index >= 64) throw new Error('GPU frame timeline exceeded 64 passes.');
          this.passes.push({ label: descriptor.label ?? label, kind: method === 'beginRenderPass' ? 'render' : 'compute',
            cpuBeginMs: performance.now() - this.start,
            colors: descriptor.colorAttachments?.map((a: any) => a && ({ load: a.loadOp, store: a.storeOp, resolve: !!a.resolveTarget })),
            depth: descriptor.depthStencilAttachment && { load: descriptor.depthStencilAttachment.depthLoadOp,
              store: descriptor.depthStencilAttachment.depthStoreOp } });
          descriptor.timestampWrites = { querySet: this.query,
            beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 };
        }
        return begin(descriptor);
      });
      return encoder;
    }));
    for (const method of ['submit', 'writeBuffer', 'writeTexture', 'copyExternalImageToTexture']) {
      this.undo.push(interceptMethod(device.queue, method, (original, args) => {
        if (this.active) this.events.push({ method, cpuMs: performance.now() - this.start,
          ...(method === 'submit' ? { buffers: args[0].map((b: any) => b.label) } : {}),
          ...(method === 'writeBuffer' ? { label: args[0].label, bytes: args[4] == null
            ? args[2].byteLength - (args[3] ?? 0) * (args[2].BYTES_PER_ELEMENT ?? 1)
            : args[4] * (args[2].BYTES_PER_ELEMENT ?? 1) } : {}) });
        return original(...args);
      }));
    }
  }
  begin() {
    if (this.busy || this.active) throw new Error('GPU timeline readback is still pending.');
    this.start = performance.now(); this.wallTimeMs = Date.now();
    this.passes = []; this.events = []; this.staleWrites = 0; this.active = true;
  }
  async end() {
    this.active = false;
    if (!this.passes.length) return null;
    this.busy = true;
    const passes = this.passes, events = this.events, staleWrites = this.staleWrites;
    const count = passes.length * 2, encoder = this.createEncoder({ label: 'offline-timeline-resolve' });
    encoder.resolveQuerySet(this.query, 0, count, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, this.read, 0, count * 8);
    this.device.queue.submit([encoder.finish()]);
    try {
      await this.read.mapAsync((globalThis as any).GPUMapMode.READ, 0, count * 8);
      const times = new BigUint64Array(this.read.getMappedRange(0, count * 8)).slice();
      this.read.unmap();
      const span = describeGpuIntervals(times)!;
      return { ...span, passes: span.intervals.map((interval, i) => ({ ...passes[i], ...interval })),
        events, staleWrites, wallTimeMs: this.wallTimeMs, rawNanoseconds: [...times].map(String) };
    } finally {
      if (this.read.mapState === 'mapped') this.read.unmap();
      this.busy = false;
    }
  }
  dispose() {
    if (this.busy) throw new Error('Await GPU timeline readback before disposal.');
    this.undo.reverse().forEach(undo => undo());
    this.read.destroy(); this.resolve.destroy(); this.query.destroy();
  }
}
