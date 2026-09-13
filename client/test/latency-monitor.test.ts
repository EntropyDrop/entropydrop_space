import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlayerPositionRemote,
  LatencyMonitor,
  loadTerrainEditRemote,
} from '../src/bootstrap/SpaceBootstrap.ts';

test('LatencyMonitor records ping and calculates smoothed exponential moving average', () => {
  const monitor = new LatencyMonitor({ apiOrigin: 'http://localhost:8000' });
  assert.equal(monitor.getPing(), null);

  monitor.recordPing(50);
  assert.equal(monitor.getPing(), 50);

  // EMA: 50 * 0.35 + 100 * 0.65 = 17.5 + 65 = 82.5 -> 83
  monitor.recordPing(100);
  assert.equal(monitor.getPing(), 83);

  // Invalid values are ignored
  monitor.recordPing(Number.NaN);
  monitor.recordPing(-10);
  assert.equal(monitor.getPing(), 83);
});

test('LatencyMonitor.probe measures round-trip time from successful ping response', async () => {
  const fetchCalls: { url: string; options: RequestInit | undefined }[] = [];
  const fetchImpl = async (url: string | URL | Request, options?: RequestInit) => {
    fetchCalls.push({ url: String(url), options });
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const monitor = new LatencyMonitor({
    apiOrigin: 'http://localhost:8000',
    fetchImpl: fetchImpl as typeof fetch,
  });

  const ping = await monitor.probe();
  assert.equal(typeof ping, 'number');
  assert.ok(ping! >= 10);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://localhost:8000/space/api/v2/ping');
});

test('LatencyMonitor.probe resets ping to null on HTTP error or network failure', async () => {
  let shouldFail = false;
  const fetchImpl = async () => {
    if (shouldFail) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  };

  const monitor = new LatencyMonitor({
    apiOrigin: 'http://localhost:8000',
    fetchImpl: fetchImpl as typeof fetch,
  });

  await monitor.probe();
  assert.ok(monitor.getPing() !== null);

  shouldFail = true;
  const result = await monitor.probe();
  assert.equal(result, null);
  assert.equal(monitor.getPing(), null);
});

test('LatencyMonitor start and stop control background polling schedule', async () => {
  let probeCount = 0;
  const fetchImpl = async () => {
    probeCount++;
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  };

  const monitor = new LatencyMonitor({
    apiOrigin: 'http://localhost:8000',
    intervalMs: 50,
    fetchImpl: fetchImpl as typeof fetch,
  });

  monitor.start();
  assert.equal(probeCount, 1);

  await new Promise(resolve => setTimeout(resolve, 140));
  assert.ok(probeCount >= 2);

  monitor.stop();
  const countAfterStop = probeCount;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(probeCount, countAfterStop);
});

test('operation requests do not contaminate the dedicated ping latency', async () => {
  const monitor = new LatencyMonitor({ apiOrigin: 'http://localhost:8000' });
  monitor.recordPing(42);
  const fetchImpl = async (url: string | URL | Request) => {
    const str = String(url);
    if (str.includes('/players/me/position')) {
      await new Promise(resolve => setTimeout(resolve, 15));
      return new Response(null, { status: 200 });
    }
    if (str.includes('/terrain-edits/batches')) {
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ applied: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ chunks: [], next_cursor: null }), { status: 200 });
  };

  const posRemote = createPlayerPositionRemote(
    'http://localhost:8000',
    'token',
    'world-1',
    fetchImpl as typeof fetch,
    monitor
  );
  await posRemote.save({ x_cm: 100, y_cm: 200, z_cm: 300, yaw_q15: 0 });
  assert.equal(monitor.getPing(), 42);

  const terrainRemote = await loadTerrainEditRemote(
    'http://localhost:8000',
    'token',
    'world-1',
    fetchImpl as typeof fetch,
    monitor
  );
  await terrainRemote.sendBatch('batch-1', [{ kind: 'clear_micro_cell', x: 0, y: 0, z: 0 }]);
  assert.equal(monitor.getPing(), 42);
});
