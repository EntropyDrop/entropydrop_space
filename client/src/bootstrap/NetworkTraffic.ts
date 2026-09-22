import { canTrackUpload, uploadWithProgress } from './UploadProgress.ts';

export interface NetworkRates {
  downloadBytesPerSecond: number;
  uploadBytesPerSecond: number;
}

const WINDOW_MS = 1000, BUCKET_MS = 10, BUCKET_COUNT = 128;
type Socket = Pick<WebSocket, 'send' | 'bufferedAmount' | 'readyState'>;

/** One-second rolling payload rates, independent of rendering/sample cadence. */
export class NetworkTraffic {
  private buckets = Array.from({ length: BUCKET_COUNT }, () => ({ id: -1, down: 0, up: 0 }));
  private sockets = new Map<Socket, number>();
  readonly now: () => number;

  constructor(now: () => number = () => performance.now()) { this.now = now; }

  private add(bytes: number, direction: 'down' | 'up', at = this.now()) {
    if (!Number.isFinite(bytes) || !Number.isFinite(at) || at < this.now() - WINDOW_MS) return;
    const id = Math.floor(at / BUCKET_MS), bucket = this.buckets[id % BUCKET_COUNT];
    if (bucket.id !== id) { bucket.id = id; bucket.down = bucket.up = 0; }
    bucket[direction] += bytes;
  }

  receive(bytes: number) { if (bytes > 0) this.add(bytes, 'down'); }
  send(bytes: number) { if (bytes > 0) this.add(bytes, 'up'); }

  /** Delayed browser timings belong to the transfer interval, never the frame
   * that happens to receive the PerformanceObserver callback. */
  receiveInterval(bytes: number, start: number, end: number) {
    if (!Number.isFinite(bytes) || !Number.isFinite(start) || !Number.isFinite(end)) return;
    if (end <= start) { this.add(bytes, 'down', end); return; }
    const first = Math.max(start, this.now() - WINDOW_MS);
    for (let at = first; at < end && at <= this.now();) {
      const next = Math.min(end, (Math.floor(at / BUCKET_MS) + 1) * BUCKET_MS);
      this.add(bytes * (next - at) / (end - start), 'down', at);
      at = next;
    }
  }

  correctDownload(bytes: number, at: number) { this.add(bytes, 'down', at); }

  pollSocket(socket: Socket) {
    const previous = this.sockets.get(socket);
    if (previous === undefined) return;
    // A closed connection can discard queued bytes; discard is not throughput.
    if (socket.readyState === 3) { this.sockets.delete(socket); return; }
    const buffered = socket.bufferedAmount;
    this.send(Math.max(0, previous - buffered));
    if (buffered > 0) this.sockets.set(socket, buffered);
    else this.sockets.delete(socket);
  }

  sentToSocket(socket: Socket, bytes: Uint8Array) {
    this.pollSocket(socket);
    const before = socket.bufferedAmount;
    socket.send(bytes as Uint8Array<ArrayBuffer>);
    const after = socket.bufferedAmount;
    this.send(Math.max(0, before + bytes.byteLength - after));
    if (after > 0) this.sockets.set(socket, after);
  }

  sample(): NetworkRates {
    for (const socket of this.sockets.keys()) this.pollSocket(socket);
    const cutoff = Math.floor((this.now() - WINDOW_MS) / BUCKET_MS);
    let down = 0, up = 0;
    for (const bucket of this.buckets) if (bucket.id > cutoff) {
      down += bucket.down; up += bucket.up;
    }
    return { downloadBytesPerSecond: Math.max(0, down), uploadBytesPerSecond: Math.max(0, up) };
  }
}

export const networkTraffic = new NetworkTraffic();

export function formatByteRate(bytes: number): string {
  const rate = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (rate >= 1024 * 1024) return `${(rate / (1024 * 1024)).toFixed(1)} MiB/s`;
  if (rate >= 1024) return `${(rate / 1024).toFixed(1)} KiB/s`;
  return `${Math.round(rate)} B/s`;
}

/** Resource timings reconcile cache hits without cloning a second body. */
export class DownloadProgress {
  private chunks = new Map<number, number>();
  private cached = false;
  private reading = false;
  private fallback = false;
  private timing: PerformanceResourceTiming | null = null;
  readonly traffic: NetworkTraffic;
  constructor(traffic: NetworkTraffic) { this.traffic = traffic; }

  read(bytes: number) {
    this.reading = true;
    // A late consumer is reading an already completed response. Its original
    // transfer interval has been counted; reading it again is not new traffic.
    if (this.fallback) return;
    if (this.cached || !(bytes > 0)) return;
    const now = this.traffic.now(), bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    this.chunks.set(bucket, (this.chunks.get(bucket) ?? 0) + bytes);
    for (const at of this.chunks.keys()) if (at < now - WINDOW_MS) this.chunks.delete(at);
    this.traffic.receive(bytes);
  }

  completeTiming(entry: PerformanceResourceTiming) {
    this.timing = entry;
    // All-zero cross-origin timing fields mean unavailable, not a cache hit.
    this.cached = entry.transferSize === 0 && entry.decodedBodySize > 0;
    if (this.cached) {
      for (const [at, bytes] of this.chunks) this.traffic.correctDownload(-bytes, at);
      this.chunks.clear();
    }
  }

  finish() {
    if (!this.reading && !this.fallback && this.timing && this.timing.transferSize > 0) {
      recordResourceTransfer(this.timing, this.traffic);
      this.fallback = true;
    }
  }
}

type PendingDownload = { url: string; start: number; progress: DownloadProgress };
const responseDownloads = new WeakMap<Response, DownloadProgress>();
const pendingDownloads = new Set<PendingDownload>();

export function recordResponseBytes(response: Response, bytes: number) {
  responseDownloads.get(response)?.read(bytes);
}

export function recordResourceTransfer(entry: PerformanceResourceTiming, traffic = networkTraffic) {
  // Use payload bytes consistently with streams and WebSocket messages.
  if (entry.transferSize > 0) traffic.receiveInterval(entry.decodedBodySize, entry.responseStart, entry.responseEnd);
}

export function sendRealtimeBytes(socket: Socket, bytes: Uint8Array, traffic = networkTraffic) {
  traffic.sentToSocket(socket, bytes);
}

export function trackFetchDownloads(nativeFetch: typeof fetch, traffic = networkTraffic): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), globalThis.location?.href ?? 'http://localhost');
    url.hash = '';
    const pending = { url: url.href, start: traffic.now(), progress: new DownloadProgress(traffic) };
    pendingDownloads.add(pending);
    // Bound retention for aborted requests and unavailable resource timings.
    if (pendingDownloads.size > 256) pendingDownloads.delete(pendingDownloads.values().next().value!);
    try {
      const response = await nativeFetch(input, init);
      responseDownloads.set(response, pending.progress);
      return response;
    } catch (error) { pendingDownloads.delete(pending); throw error; }
  };
}

let installed = false;
/** Install before auth interception so retries retain their own progress. */
export function installNetworkTrafficMonitor() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const trackedFetch = trackFetchDownloads(window.fetch.bind(window));
  window.fetch = async (input, init) => canTrackUpload(input, init)
    ? uploadWithProgress(input, init, networkTraffic) : trackedFetch(input, init);
  if (typeof PerformanceObserver === 'undefined') return;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      const match = [...pendingDownloads].filter(item => entry.initiatorType === 'fetch'
        && item.url === entry.name && item.start <= entry.startTime)
        .sort((a, b) => b.start - a.start)[0];
      if (!match) { recordResourceTransfer(entry); continue; }
      pendingDownloads.delete(match);
      match.progress.completeTiming(entry);
      // Let a reader in this task claim the transfer before falling back to
      // timings for resources read outside NetworkSafety (images or music).
      setTimeout(() => match.progress.finish(), 0);
    }
  });
  try { observer.observe({ type: 'resource' }); }
  catch { observer.disconnect(); }
}
