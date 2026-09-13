export class NetworkPayloadTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Network response exceeds the ${maxBytes} byte safety limit.`);
    this.name = 'NetworkPayloadTooLargeError';
    this.maxBytes = maxBytes;
  }
}

const OFF_MAIN_THREAD_JSON_THRESHOLD_BYTES = 256 * 1024;
let jsonParserWorker: Worker | null = null;
let jsonParserRequestId = 0;
const pendingJsonParses = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();

function rejectPendingJsonParses(error: Error) {
  for (const pending of pendingJsonParses.values()) pending.reject(error);
  pendingJsonParses.clear();
}

function getJsonParserWorker(): Worker | null {
  if (jsonParserWorker) return jsonParserWorker;
  if (typeof document === 'undefined' || typeof Worker !== 'function') return null;
  try {
    jsonParserWorker = new Worker(new URL('./JsonParseWorker.ts', import.meta.url), {
      type: 'module',
      name: 'space-json-parser',
    });
    jsonParserWorker.onmessage = event => {
      const id = Number(event.data?.id);
      const pending = pendingJsonParses.get(id);
      if (!pending) return;
      pendingJsonParses.delete(id);
      if (event.data?.ok) pending.resolve(event.data.value);
      else pending.reject(new SyntaxError(event.data?.error || 'Invalid JSON response.'));
    };
    jsonParserWorker.onerror = event => {
      const error = new Error(event.message || 'The JSON parser worker stopped unexpectedly.');
      rejectPendingJsonParses(error);
      jsonParserWorker?.terminate();
      jsonParserWorker = null;
    };
    return jsonParserWorker;
  } catch {
    jsonParserWorker = null;
    return null;
  }
}

function parseJsonBytesOffMainThread<T>(bytes: Uint8Array): Promise<T> | null {
  if (bytes.byteLength < OFF_MAIN_THREAD_JSON_THRESHOLD_BYTES) return null;
  const worker = getJsonParserWorker();
  if (!worker) return null;
  const id = ++jsonParserRequestId;
  const transferable = bytes.byteOffset === 0
    && bytes.buffer instanceof ArrayBuffer
    && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  return new Promise<T>((resolve, reject) => {
    pendingJsonParses.set(id, { resolve: value => resolve(value as T), reject });
    try {
      worker.postMessage({ id, buffer: transferable }, [transferable]);
    } catch (error) {
      pendingJsonParses.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function isLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(normalized)) return true;
  if (normalized.endsWith('.local')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(normalized)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(normalized)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(normalized)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(normalized);
}

/** Resolve an external browser fetch target without allowing cleartext Internet URLs. */
export function resolveSafeHttpUrl(input: string, baseUrl?: string): URL {
  const url = new URL(input, baseUrl);
  const secure = url.protocol === 'https:';
  const localHttp = url.protocol === 'http:' && isLocalDevelopmentHost(url.hostname);
  if (!secure && !localHttp) {
    throw new Error('Remote resources must use HTTPS (HTTP is allowed only for local development).');
  }
  return url;
}

/** Read a response incrementally so a corrupt CDN/API cannot force a huge allocation. */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  const declaredLength = Number(response.headers?.get?.('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new NetworkPayloadTooLargeError(maxBytes);
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new NetworkPayloadTooLargeError(maxBytes);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new NetworkPayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readJsonResponse<T = unknown>(
  response: Response,
  maxBytes: number,
  options: { offMainThread?: boolean } = {},
): Promise<T | null> {
  const bytes = await readResponseBytes(response, maxBytes);
  if (bytes.byteLength === 0) return null;
  if (options.offMainThread) {
    const pending = parseJsonBytesOffMainThread<T>(bytes);
    if (pending) return pending;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is unavailable; resource integrity cannot be verified.');
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = new Uint8Array(await subtle.digest('SHA-256', input));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}
