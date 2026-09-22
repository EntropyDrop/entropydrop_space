import type { NetworkTraffic } from './NetworkTraffic.ts';

/** Keep native fetch for options XHR cannot preserve, especially unload saves. */
export function canTrackUpload(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (typeof XMLHttpRequest === 'undefined') return false;
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input), globalThis.location?.href);
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if ((init?.mode ?? request?.mode) === 'same-origin' && url.origin !== globalThis.location?.origin) return false;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const body = init?.body ?? request?.body;
  return method !== 'GET' && method !== 'HEAD' && body != null
    && !(init?.body instanceof ReadableStream)
    && !(init?.keepalive ?? request?.keepalive)
    && (init?.mode ?? request?.mode) !== 'no-cors'
    && (init?.credentials ?? request?.credentials) !== 'omit'
    && (init?.redirect ?? request?.redirect ?? 'follow') === 'follow'
    && !(init?.integrity ?? request?.integrity)
    && init?.referrer === undefined && !(init?.referrerPolicy ?? request?.referrerPolicy)
    && (!request || request.referrer === 'about:client');
}

/** XHR exposes actual request-body progress; fetch only exposes its response.
 * Serialize through Request to preserve multipart boundaries and content types.
 * Only body-bearing foreground requests use this path; terrain GETs still stream.
 */
export async function uploadWithProgress(input: RequestInfo | URL, init: RequestInit | undefined,
  traffic: NetworkTraffic, createXhr = () => new XMLHttpRequest()): Promise<Response> {
  const target = input instanceof Request ? input : new URL(String(input), globalThis.location?.href);
  const request = new Request(target, init);
  if (request.signal.aborted) throw request.signal.reason;
  const body = await request.blob();
  if (request.signal.aborted) throw request.signal.reason;
  return new Promise<Response>((resolve, reject) => {
    const xhr = createXhr();
    let uploaded = 0;
    const recordUpload = (event: ProgressEvent) => {
      if (!Number.isFinite(event.loaded) || event.loaded < uploaded) return;
      const current = Math.max(uploaded, event.loaded);
      traffic.send(current - uploaded);
      uploaded = current;
    };
    const abort = () => { xhr.abort(); reject(request.signal.reason); };
    const cleanup = () => request.signal.removeEventListener('abort', abort);
    xhr.upload.onprogress = recordUpload;
    xhr.upload.onload = recordUpload;
    // Upload replies are bounded API acknowledgements. Keep an upper bound
    // before creating the Response, since XHR receives its body as a Blob.
    xhr.onprogress = event => {
      if (event.loaded > 16 * 1024 * 1024) {
        reject(new RangeError('Upload response exceeds the 16 MiB safety limit'));
        xhr.abort();
      }
    };
    xhr.onload = () => {
      cleanup();
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const separator = line.indexOf(':');
        if (separator > 0) headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
      }
      const response = new Response([204, 205, 304].includes(xhr.status) ? null : xhr.response,
        { status: xhr.status, statusText: xhr.statusText, headers });
      Object.defineProperties(response, {
        url: { value: xhr.responseURL },
        redirected: { value: xhr.responseURL !== request.url },
        type: { value: new URL(request.url).origin === globalThis.location?.origin ? 'basic' : 'cors' },
      });
      resolve(response);
    };
    xhr.onerror = () => { cleanup(); reject(new TypeError('Network request failed')); };
    xhr.onabort = () => { cleanup(); reject(request.signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    xhr.ontimeout = () => { cleanup(); reject(new TypeError('Network request timed out')); };
    xhr.open(request.method, request.url, true);
    xhr.responseType = 'blob';
    xhr.withCredentials = request.credentials === 'include';
    request.headers.forEach((value, key) => xhr.setRequestHeader(key, value));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) { abort(); return; }
    try { xhr.send(body); }
    catch (error) { cleanup(); reject(error); }
  });
}
