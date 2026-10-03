import { VoxelLodPlanner, voxelTileBytes, voxelTileTransfers,
  type VoxelLodSource, type VoxelLodView, type VoxelLodTile, type VoxelLodStats } from './VoxelLodPlanner.ts';

export type VoxelLodCommand =
  | { type: 'begin'; key: string; x: number; z: number; token: number; levels: { cellSize: number; length: number }[] }
  | { type: 'part'; key: string; token: number; level: number; offset: number; bytes: Uint8Array }
  | { type: 'end'; key: string; token: number }
  | { type: 'link'; key: string; x: number; z: number; token: number; sourceKey: string; sourceToken: number }
  | { type: 'remove'; key: string }
  | { type: 'build'; id: number; view: VoxelLodView }
  | { type: 'ack'; id: number };
export type VoxelLodResponse =
  | { type: 'tiles'; id: number; tiles: VoxelLodTile[] }
  | { type: 'done'; id: number; stats: VoxelLodStats }
  | { type: 'error'; message: string };
export interface VoxelLodPort {
  onmessage: ((event: { data: VoxelLodResponse }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  postMessage(command: VoxelLodCommand, transfer?: ArrayBuffer[]): void;
  terminate(): unknown;
}

/** One outstanding packet bounds unpublished geometry and message traffic.
 * Input sources and the latest camera can queue while a build is in progress. */
export function createVoxelLodService(post: (response: VoxelLodResponse, transfer: ArrayBuffer[]) => void, sliceMs = 4) {
  const planner = new VoxelLodPlanner(), receiving = new Map<string, VoxelLodSource>();
  const retained = new Map<string, VoxelLodSource>();
  const latest = new Map<string, number>();
  const jobs: (() => Generator<void | VoxelLodTile, void | VoxelLodStats>)[] = [];
  let active: ReturnType<(typeof jobs)[number]> | null = null, buildId = 0;
  let packet: VoxelLodTile[] = [], bytes = 0, waiting = false, stopped = false;
  let completed: VoxelLodStats | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  function schedule() {
    if (!stopped && !waiting && timer === null) timer = setTimeout(run, 0);
  }
  function flush() {
    const tiles = packet; packet = []; bytes = 0; waiting = true;
    post({ type: 'tiles', id: buildId, tiles }, tiles.flatMap(voxelTileTransfers));
  }
  function run() {
    timer = null;
    if (stopped || waiting) return;
    const deadline = performance.now() + sliceMs;
    try {
      if (completed) {
        post({ type: 'done', id: buildId, stats: completed }, []); completed = null;
      }
      do {
        if (!active) active = jobs.shift()?.() ?? null;
        if (!active) break;
        const result = active.next();
        if (result.done === true) {
          active = null;
          if (result.value) {
            completed = result.value;
            if (packet.length) { flush(); return; }
            post({ type: 'done', id: buildId, stats: completed }, []); completed = null;
          }
        } else if (result.value) {
          // A replacement/removal received during this build invalidates its output.
          const tile = result.value;
          if (latest.get(tile.key) === tile.token) { packet.push(tile); bytes += voxelTileBytes(tile); }
          if (bytes >= 512 * 1024 || packet.length >= 64) { flush(); return; }
        }
      } while (performance.now() < deadline);
      if (packet.length) { flush(); return; }
      if (active || jobs.length) schedule();
    } catch (error) {
      stopped = true; post({ type: 'error', message: String(error) }, []);
    }
  }
  return {
    handle(command: VoxelLodCommand) {
      if (stopped) return;
      switch (command.type) {
        case 'begin':
          latest.set(command.key, command.token);
          receiving.set(command.key, { key: command.key, x: command.x, z: command.z, token: command.token,
            mips: command.levels.map(level => ({ cellSize: level.cellSize, faces: new Uint8Array(level.length) })) });
          break;
        case 'part': {
          const source = receiving.get(command.key);
          if (source?.token === command.token) source.mips[command.level].faces.set(command.bytes, command.offset);
          break;
        }
        case 'end': {
          const source = receiving.get(command.key);
          if (source?.token === command.token) {
            receiving.delete(command.key);
            retained.set(command.key, source);
            jobs.push(function* () {
              if (latest.get(source.key) === source.token) yield* planner.install(source);
            });
          }
          break;
        }
        case 'link': {
          const original = retained.get(command.sourceKey);
          if (!original || original.token !== command.sourceToken) {
            post({ type: 'error', message: 'Missing immutable voxel source alias' }, []); break;
          }
          const source = { key: command.key, x: command.x, z: command.z, token: command.token, mips: original.mips };
          receiving.delete(command.key);
          latest.set(source.key, source.token); retained.set(source.key, source);
          jobs.push(function* () {
            if (latest.get(source.key) === source.token) yield* planner.install(source);
          });
          break;
        }
        case 'remove':
          latest.delete(command.key); receiving.delete(command.key); retained.delete(command.key);
          jobs.push(function* () { planner.remove(command.key); });
          break;
        case 'build':
          jobs.push(function* () { buildId = command.id; return yield* planner.build(command.view); });
          break;
        case 'ack':
          if (command.id === buildId) waiting = false;
          break;
      }
      schedule();
    },
    dispose() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null; active = null; jobs.length = 0; packet = []; receiving.clear(); retained.clear(); latest.clear();
    },
  };
}

/** Same planner and protocol, with cooperative slices rather than a blocking
 * synchronous rebuild if a browser cannot create (or loses) its worker. */
export function createCooperativeVoxelLodPort(): VoxelLodPort {
  const port: VoxelLodPort = { onmessage: null, onerror: null,
    postMessage(command) { service.handle(command); }, terminate() { service.dispose(); } };
  const service = createVoxelLodService(response => port.onmessage?.({ data: response }), 1);
  return port;
}
