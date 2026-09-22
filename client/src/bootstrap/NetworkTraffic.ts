export interface NetworkRates {
  downloadBytesPerSecond: number;
  uploadBytesPerSecond: number;
}

/** A bounded accumulator; sampling an idle connection returns to zero. */
export class NetworkTraffic {
  private received = 0;
  private sent = 0;
  private sampledAt: number;
  private readonly now: () => number;
  private rates: NetworkRates = { downloadBytesPerSecond: 0, uploadBytesPerSecond: 0 };

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.sampledAt = now();
  }

  receive(bytes: number) { if (Number.isFinite(bytes) && bytes > 0) this.received += bytes; }
  send(bytes: number) { if (Number.isFinite(bytes) && bytes > 0) this.sent += bytes; }

  sample(): NetworkRates {
    const now = this.now(), elapsed = now - this.sampledAt;
    if (elapsed >= 1000) {
      this.rates = { downloadBytesPerSecond: this.received * 1000 / elapsed,
        uploadBytesPerSecond: this.sent * 1000 / elapsed };
      this.received = this.sent = 0;
      this.sampledAt = now;
    }
    return this.rates;
  }
}

export const networkTraffic = new NetworkTraffic();

export function bodyByteLength(body: BodyInit | null | undefined): number {
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  // Do not consume request streams or serialize multipart bodies for telemetry.
  return 0;
}

export function formatByteRate(bytes: number): string {
  const rate = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (rate >= 1024 * 1024) return `${(rate / (1024 * 1024)).toFixed(1)} MiB/s`;
  if (rate >= 1024) return `${(rate / 1024).toFixed(1)} KiB/s`;
  return `${Math.round(rate)} B/s`;
}

export function recordResourceTransfer(entry: Pick<PerformanceResourceTiming, 'transferSize'>,
  traffic = networkTraffic) {
  // transferSize is zero for HTTP-cache hits. Never substitute decodedBodySize,
  // which would turn disk-cache reads into fictitious network traffic.
  traffic.receive(entry.transferSize);
}

export function trackHttpUploads(fetchImpl: typeof fetch, traffic = networkTraffic): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    traffic.send(bodyByteLength(init?.body));
    return response;
  };
}

export function sendRealtimeBytes(socket: Pick<WebSocket, 'send'>, bytes: Uint8Array,
  traffic = networkTraffic) {
  socket.send(bytes as Uint8Array<ArrayBuffer>);
  traffic.send(bytes.byteLength);
}

let installed = false;
/** Install before the auth interceptor, so each real retry is counted once. */
export function installNetworkTrafficMonitor() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.fetch = trackHttpUploads(window.fetch.bind(window));
  if (typeof PerformanceObserver === 'undefined') return;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) recordResourceTransfer(entry as PerformanceResourceTiming);
  });
  try { observer.observe({ type: 'resource' }); }
  catch { observer.disconnect(); }
}
