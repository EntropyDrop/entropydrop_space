type JsonParseRequest = {
  id: number;
  buffer: ArrayBuffer;
};

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<JsonParseRequest>) => {
  const { id, buffer } = event.data;
  try {
    const json = new TextDecoder().decode(new Uint8Array(buffer));
    const value = JSON.parse(json);
    workerScope.postMessage({ id, ok: true, value });
  } catch (error) {
    workerScope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
