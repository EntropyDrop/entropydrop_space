/** Warm-cache IPC comparison. No GPU timing and no player-save writes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createInterface } from 'node:readline';

const root = resolve(process.argv[2] ?? 'native-space/data/worlds/aether-archipelago');
const output = resolve(process.argv[3] ?? 'native-space/results/lod-loading.json');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const dir = join(root, 'distant', manifest.source_hash);
const camera = [manifest.spawn[0] + 100, manifest.spawn[1] + 80, manifest.spawn[2] + 100];
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
async function run(legacy: boolean) {
  const start = performance.now();
  const child = spawn(process.execPath, [resolve('native-space/tools/distant.ts'), root, ...(legacy ? ['--legacy-loading'] : [])],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = new Promise<void>(r => child.once('exit', () => r()));
  const timeout = setTimeout(() => child.kill(), 300000);
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const tiles = new Map<string, unknown>(), frames: unknown[] = [];
  const stateHash = () => hash(JSON.stringify([...tiles].sort(([a], [b]) => a.localeCompare(b))));
  const request = async (position = camera) => {
    const sent = performance.now();
    child.stdin.write(JSON.stringify({ camera: position, height: 2178, torus: true, edits: [] }) + '\n');
    const row = await lines.next(); assert.ok(!row.done, errors || 'LOD child exited');
    const frame = JSON.parse(row.value); assert.equal(frame.ok, true, frame.error);
    const received = performance.now();
    for (const tile of frame.tiles) tiles.set(tile.key, { faces: tile.faces, bounds: tile.bounds,
      origin: tile.origin, digest: hash(readFileSync(join(dir, tile.file))) });
    frames.push({ elapsed_ms: received-start, ipc_ms: received-sent, zones: frame.zones, refined: frame.refinedZones,
      phase: frame.phase, total_ms: frame.totalMs, planning_ms: frame.planningMs, packing_ms: frame.packingMs,
      tiles: frame.tiles.length, faces: frame.stats.faces, source_bytes: frame.sourceBytes });
    return frame;
  };
  try {
    const first = await request(); let frame = first;
    for (let i = 0; !frame.ready && i < 129; i++) frame = await request();
    assert.ok(frame.ready, 'All 128 full sources must finish');
    const settled = stateHash(), loaded = performance.now()-start;
    const idle = await request(); assert.equal(idle.tiles.length, 0);
    for (const delta of [[10,0,0], [25,10,20], [0,0,0]]) await request(camera.map((v,i) => v+delta[i]));
    return { legacy, first_zones: first.zones, first_refined: first.refinedZones, loaded_ms: loaded,
      final_faces: frame.stats.faces, source_bytes: frame.sourceBytes, settled_hash: settled, moved_hash: stateHash(), frames };
  } finally { clearTimeout(timeout); child.kill(); await ended; }
}

// Populate the optional overview cache outside all measured runs.
console.log('Warming source and coverage caches'); await run(false);
const runs = [];
for (const legacy of [true, false, false, true]) {
  const result = await run(legacy); runs.push(result);
  console.log(JSON.stringify({ legacy, loaded_ms: result.loaded_ms, faces: result.final_faces, hash: result.settled_hash }));
}
for (const result of runs) {
  assert.equal(result.settled_hash, runs[0].settled_hash, 'Settled geometry differs');
  assert.equal(result.moved_hash, runs[0].moved_hash, 'Moving geometry differs');
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ world: manifest, height: 2178, camera, runs,
  limitations: ['Node IPC timings include local tile-file writes and OS scheduling, but exclude GPU upload/rendering.',
    'Run order is legacy, candidate, candidate, legacy with prewarmed caches. No 500 ms application pacing is imposed.',
    'All final tile bytes, bounds, origins and face counts must match after full refinement and after identical movement.'] }, null, 2));
