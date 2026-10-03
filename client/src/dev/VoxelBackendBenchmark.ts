/** Local-only backend experiment. Never imported by the application. */
import * as THREE from 'three';
import { WebGPURenderer, MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, attribute, positionGeometry, uniform, vec2, vec3, float, sin, cos, min, max,
  dot, normalize, mix, smoothstep, varying } from 'three/tsl';
import { bendPoint, TORUS_R, TORUS_RHO, TORUS_K_THETA, TORUS_K_PHI } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import type { VoxelLodTile } from '@entropydrop/space-engine/render/VoxelLodPlanner.ts';
import { frameMetrics } from './FrameMetrics.ts';

type Backend = 'legacy' | 'webgpu' | 'fallback';
type View = 'near' | 'across' | 'motion' | 'uploads';
type Renderer = THREE.WebGLRenderer | WebGPURenderer;
type Entry = { kind: Backend; renderer: Renderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  meshes: THREE.Mesh[]; tiles: VoxelLodTile[]; bounds: THREE.Sphere[];
  target: THREE.WebGLRenderTarget; timer: Timer; cameraUniform: { value: THREE.Vector3 }; };
type Timer = { begin(sample: boolean): void; end(): void; drain(): Promise<void>; reset(): void; values: number[]; supported: boolean };
const $ = (id: string) => document.getElementById(id)!;
const status = (message: string) => { $('status').textContent = message; };
const WIDTH = 1280, HEIGHT = 720, WARMUP = 120, SAMPLES = 300;
const names: Record<Backend, string> = { legacy: 'WebGLRenderer', webgpu: 'WebGPU', fallback: 'Node / WebGL2' };
const background = new THREE.Color('#74b9ff');
const sky = new THREE.Vector3(background.r, background.g, background.b);
const light = new THREE.Vector3(-.3, .8, .5).normalize();
const tubeFactor = Math.sqrt(9 / 7);
const results: any = { scope: 'Settled Aether terrain only; frozen LOD during motion; simplified shared diffuse lighting; no PBR, view flattening, near terrain, handoff, fades, post-processing, streaming, networking or UI.',
  three: THREE.REVISION, width: WIDTH, height: HEIGHT, antialias: false, warmupFrames: WARMUP, sampleFrames: SAMPLES,
  gpuSampling: 'One asynchronous query per six frames, excluded from CPU submit measurement; no GPU wait in timed frames.',
  startedAt: new Date().toISOString(), userAgent: navigator.userAgent, rows: [], pixels: [], errors: [] };
const entries = new Map<Backend, Entry>();
type ReplayPacket = { x: number; tiles: VoxelLodTile[]; workerMs: number; faces: number };
let replayPackets: ReplayPacket[] = [];
const tileKey = (tile: VoxelLodTile) => `${tile.key}:${tile.tile}`;
const tileIndices = new Map<string, number>();
let tiles: VoxelLodTile[] = [], spheres: THREE.Sphere[] = [], running = false, invalidated = false;
const frustum = new THREE.Frustum(), matrix = new THREE.Matrix4();
const canonicalCamera = new THREE.PerspectiveCamera(75, WIDTH / HEIGHT, .1, 10000);
const visibility: boolean[] = [];
const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const summary = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)],
    p99: sorted[Math.floor(sorted.length * .99)], max: sorted.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length };
};
function showResults() {
  $('results').textContent = JSON.stringify(results, null, 2);
  $('rows').replaceChildren(...results.rows.map(row => {
    const tr = document.createElement('tr');
    for (const value of [`${row.view} #${row.round} / ${names[row.backend as Backend]}`,
      `${row.cpu.p50.toFixed(2)} / ${row.cpu.p95.toFixed(2)}`, row.gpu?.p50.toFixed(2) ?? 'unavailable',
      `${row.frame.p50.toFixed(2)} / ${row.frame.p95.toFixed(2)}`, row.draws.mean.toFixed(0), row.triangles.mean.toFixed(0)]) {
      const td = document.createElement('td'); td.textContent = String(value); tr.append(td);
    }
    return tr;
  }));
  $('extended-rows').replaceChildren(...(results.extended ?? []).map((row: any) => {
    const tr = document.createElement('tr');
    for (const value of [`${row.width}x${row.height} ${row.view} #${row.round} / ${names[row.backend as Backend]}`,
      `${row.cadence.averageFps.toFixed(1)} / ${row.cadence.onePercentLowFps.toFixed(1)}`,
      `${row.cadence.p95Ms.toFixed(2)} / ${row.cadence.p99Ms.toFixed(2)}`, `${row.cadence.over16_67Percent.toFixed(1)}%`,
      `${row.cpuTotal.p50.toFixed(2)} / ${row.cpuTotal.p95.toFixed(2)}`,
      row.gpu ? `${row.gpu.p50.toFixed(2)} / ${row.gpu.p95.toFixed(2)}` : 'unavailable']) {
      const td = document.createElement('td'); td.textContent = String(value); tr.append(td);
    }
    return tr;
  }));
  $('completion-results').textContent = (results.completionBatches ?? []).map((row: any) =>
    `${row.width}x${row.height} ${row.view} ${names[row.backend as Backend]} [batch ${row.batchSize}, round ${row.round ?? 1}]: ${row.millisecondsPerRender.p50.toFixed(2)} ms/render p50, ${row.millisecondsPerRender.p95.toFixed(2)} ms/render p95 (GPU completed)`
  ).join('\n');
  ($('download') as HTMLButtonElement).disabled = false;
}

// Shader work is deliberately equivalent on both backends. Packed attributes
// and tile granularity come directly from the production LOD planner.
const vertexShader = `
attribute vec4 voxelOffset; attribute vec2 voxelSpan; attribute float voxelDirection;
attribute vec4 voxelColor; uniform vec3 origin; uniform vec3 cameraBent;
varying vec3 vLit; varying float vDistance;
void main() {
  float d=voxelDirection, s=mod(d,2.)*2.-1.;
  vec2 uv=position.xy; if(s<0.) uv.x=1.-uv.x;
  vec2 q=uv*voxelSpan*.125;
  vec3 p=origin+voxelOffset.xyz*.125+(d<2.?vec3(0.,q.x,q.y):d<4.?vec3(q.y,0.,q.x):vec3(q.x,q.y,0.));
  float theta=p.x*${TORUS_K_THETA};
  float h=p.z*${TORUS_K_PHI * .5}, a=sin(h), b=cos(h);
  float denom=b*b+${tubeFactor * tubeFactor}*a*a;
  float cp=(b*b-${tubeFactor * tubeFactor}*a*a)/denom, sp=${2 * tubeFactor}*a*b/denom;
  float ct=cos(theta), st=sin(theta);
  float rho=min(${TORUS_RHO}+(p.y-16.)*(${TORUS_R}+${TORUS_RHO}*cp)/${TORUS_R},${TORUS_R - 1});
  vec3 bent=vec3((${TORUS_R}+rho*cp)*ct,rho*sp,(${TORUS_R}+rho*cp)*st);
  vec3 n=s*(d<2.?vec3(-st,0.,ct):d<4.?vec3(cp*ct,sp,cp*st):vec3(-sp*ct,cp,-sp*st));
  vLit=voxelColor.rgb*(.45+.55*max(dot(normalize(n),vec3(${light.x},${light.y},${light.z})),0.));
  vDistance=length(bent-cameraBent);
  gl_Position=projectionMatrix*viewMatrix*vec4(bent,1.);
}`;
const fragmentShader = `varying vec3 vLit; varying float vDistance; uniform vec3 sky;
void main(){gl_FragColor=vec4(mix(vLit,sky,smoothstep(4000.,9000.,vDistance)),1.);
#include <colorspace_fragment>
}`;
function nodeMaterial(origin: THREE.Vector3, camera: { value: THREE.Vector3 }) {
  const dir = float(attribute('voxelDirection', 'float'));
  const flat = Fn(() => {
    const uv = positionGeometry.xy.toVar();
    uv.x.assign(dir.mod(2).lessThan(.5).select(float(1).sub(uv.x), uv.x));
    const q = uv.mul(attribute('voxelSpan', 'vec2')).mul(.125);
    const local = dir.lessThan(2).select(vec3(0, q.x, q.y), dir.lessThan(4).select(vec3(q.y, 0, q.x), vec3(q.x, q.y, 0)));
    return uniform(origin).add(vec3(attribute('voxelOffset', 'vec4')).mul(.125)).add(local);
  })();
  const trig = Fn(() => {
    const h = flat.z.mul(TORUS_K_PHI * .5), a = sin(h), b = cos(h);
    const denominator = b.mul(b).add(a.mul(a).mul(tubeFactor * tubeFactor));
    return vec2(b.mul(b).sub(a.mul(a).mul(tubeFactor * tubeFactor)).div(denominator),
      a.mul(b).mul(2 * tubeFactor).div(denominator));
  })();
  const bent = Fn(() => {
    const rho = min(float(TORUS_RHO).add(flat.y.sub(16).mul(float(TORUS_R).add(trig.x.mul(TORUS_RHO))).div(TORUS_R)), TORUS_R - 1);
    const radial = float(TORUS_R).add(rho.mul(trig.x)), theta = flat.x.mul(TORUS_K_THETA);
    return vec3(radial.mul(cos(theta)), rho.mul(trig.y), radial.mul(sin(theta)));
  })();
  const normal = Fn(() => {
    const t = flat.x.mul(TORUS_K_THETA), ct = cos(t), st = sin(t), cp = trig.x, sp = trig.y;
    return dir.lessThan(2).select(vec3(st.negate(), 0, ct),
      dir.lessThan(4).select(vec3(cp.mul(ct), sp, cp.mul(st)), vec3(sp.mul(ct).negate(), cp, sp.mul(st).negate())))
      .mul(dir.mod(2).mul(2).sub(1));
  })();
  const lit = varying(vec3(attribute('voxelColor', 'vec4')).mul(max(dot(normalize(normal), vec3(light)), 0).mul(.55).add(.45)));
  const distance = varying(bent.sub(uniform(camera.value)).length());
  const material = new MeshBasicNodeMaterial();
  material.positionNode = bent;
  material.colorNode = mix(lit, vec3(sky), smoothstep(4000, 9000, distance));
  material.toneMapped = false;
  return material;
}
function geometry(tile: VoxelLodTile) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 1,1,0, 0,1,0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0,1,0, 0,1,0, 0,1,0, 0,1,0], 3));
  g.setIndex([0,1,2,0,2,3]); g.instanceCount = tile.count;
  // Four-byte vertex strides are required by WebGPU. Use the same padded
  // layout for every backend, and report the padding separately from source.
  // r183 expands unnormalized 8/16-bit attributes to 32-bit on WebGPU;
  // expand explicitly on all backends to keep this experiment equivalent.
  const offset = new Float32Array(tile.count * 4), color = new Uint8Array(tile.count * 4);
  for (let i = 0; i < tile.count; i++) {
    offset.set(tile.offset.subarray(i * 3, i * 3 + 3), i * 4);
    color.set(tile.color.subarray(i * 3, i * 3 + 3), i * 4); color[i * 4 + 3] = 255;
  }
  g.setAttribute('voxelOffset', new THREE.InstancedBufferAttribute(offset, 4));
  g.setAttribute('voxelSpan', new THREE.InstancedBufferAttribute(Float32Array.from(tile.span), 2));
  g.setAttribute('voxelDirection', new THREE.InstancedBufferAttribute(Float32Array.from(tile.direction), 1));
  g.setAttribute('voxelColor', new THREE.InstancedBufferAttribute(color, 4, true));
  return g;
}
function makeTimer(renderer: Renderer, kind: Backend): Timer {
  const values: number[] = [];
  if (kind !== 'legacy') {
    const r = renderer as WebGPURenderer, backend = r.backend as any;
    const supported = r.hasFeature('timestamp-query');
    let pending: Promise<void> | null = null, enabled = false;
    backend.trackTimestamp = false;
    return { values, supported, begin(sample) { enabled = supported && sample && !pending; backend.trackTimestamp = enabled; },
      end() { if (enabled) pending = r.resolveTimestampsAsync().then(ms => { if (typeof ms === 'number' && ms > 0) values.push(ms); })
        .finally(() => { pending = null; }); backend.trackTimestamp = false; },
      async drain() { await pending; }, reset() { values.length = 0; } };
  }
  const gl = (renderer as THREE.WebGLRenderer).getContext() as WebGL2RenderingContext, ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const pending: WebGLQuery[] = []; let active: WebGLQuery | null = null;
  function poll() {
    if (!ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    while (pending.length && (disjoint || gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE))) {
      const query = pending.shift()!;
      if (!disjoint) values.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query);
    }
  }
  return { values, supported: !!ext, begin(sample) { poll(); if (ext && sample && pending.length < 8) {
    active = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, active); } },
  end() { if (active) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); active = null; } },
  async drain() { const deadline = performance.now() + 3000; while (pending.length && performance.now() < deadline) { await delay(8); poll(); }
    while (pending.length) gl.deleteQuery(pending.shift()!); }, reset() { values.length = 0; } };
}
async function makeEntry(kind: Backend) {
  status(`Initializing ${names[kind]}...`); await nextFrame();
  const canvas = document.createElement('canvas');
  let renderer: Renderer;
  const initStart = performance.now();
  if (kind === 'legacy') renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  else {
    renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: kind === 'fallback', trackTimestamp: true });
    await renderer.init();
    if (kind === 'webgpu' && !(renderer.backend as any).isWebGPUBackend) throw new Error('WebGPU unavailable: refusing to benchmark a silent WebGL fallback.');
  }
  renderer.setPixelRatio(1); renderer.setSize(WIDTH, HEIGHT, false); renderer.setClearColor(background);
  renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  const cameraUniform = { value: new THREE.Vector3() }, scene = new THREE.Scene();
  const meshes = tiles.map(tile => {
    const [x, z] = tile.key.split(',').map(Number), origin = new THREE.Vector3(x * 512, 0, z * 512);
    const material = kind === 'legacy' ? new THREE.ShaderMaterial({ vertexShader, fragmentShader, toneMapped: false,
      uniforms: { origin: { value: origin }, cameraBent: cameraUniform, sky: { value: sky } } }) : nodeMaterial(origin, cameraUniform);
    const mesh = new THREE.Mesh(geometry(tile), material); mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
    scene.add(mesh); return mesh;
  });
  const target = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { type: THREE.UnsignedByteType, depthBuffer: true });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const entry: Entry = { kind, renderer, scene, meshes, target, cameraUniform,
    tiles: [...tiles], bounds: spheres.map(sphere => sphere.clone()),
    camera: new THREE.PerspectiveCamera(75, WIDTH / HEIGHT, .1, 10000), timer: makeTimer(renderer, kind) };
  entries.set(kind, entry);
  results.backends ??= {};
  results.backends[kind] = { initAndSceneMs: performance.now() - initStart, gpuTimer: entry.timer.supported };
  if (kind === 'legacy') {
    const gl = (renderer as THREE.WebGLRenderer).getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    results.backends[kind].device = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } else if (kind === 'webgpu') {
    const device = ((renderer as WebGPURenderer).backend as any).device;
    results.backends[kind].adapter = device.adapterInfo;
    device.addEventListener('uncapturederror', (event: any) => fail(event.error));
    device.lost.then((info: any) => { if (info.reason !== 'destroyed') fail(new Error(`GPU device lost: ${info.message}`)); });
  }
  return entry;
}
function pose(view: View, step: number, sampleCount = SAMPLES, entry?: Entry) {
  const t = step / sampleCount, x = view === 'uploads' ? 8192 + Math.min(12, Math.floor(step / 60) + 1) * 16
    : 8192 + (view === 'motion' ? Math.sin(t * Math.PI * 2) * 256 : 0);
  canonicalCamera.position.copy(bendPoint(x, 180, 1024));
  canonicalCamera.up.copy(bendPoint(x, 181, 1024)).sub(canonicalCamera.position).normalize();
  if (view === 'across') canonicalCamera.lookAt(0, 0, 0);
  else {
    const yaw = view === 'motion' ? t * Math.PI * 2 : 0;
    canonicalCamera.lookAt(bendPoint(x + Math.cos(yaw) * 64, 130, 1024 + Math.sin(yaw) * 64));
  }
  canonicalCamera.updateMatrixWorld(true);
  frustum.setFromProjectionMatrix(matrix.multiplyMatrices(canonicalCamera.projectionMatrix, canonicalCamera.matrixWorldInverse));
  let draws = 0, triangles = 0;
  for (let i = 0; i < tiles.length; i++) {
    const tile = entry?.tiles[i] ?? tiles[i];
    visibility[i] = tile.count > 0 && frustum.intersectsSphere(entry?.bounds[i] ?? spheres[i]);
    if (visibility[i]) { draws++; triangles += tile.count * 2; }
  }
  return { draws, triangles };
}
function sync(entry: Entry) {
  entry.camera.position.copy(canonicalCamera.position); entry.camera.quaternion.copy(canonicalCamera.quaternion);
  entry.camera.updateMatrixWorld(true); entry.cameraUniform.value.copy(canonicalCamera.position);
  for (let i = 0; i < tiles.length; i++) entry.meshes[i].visible = visibility[i];
}
function showEntry(entry: Entry) { $('view').replaceChildren(entry.renderer.domElement); }
async function measure(entry: Entry, view: View, round: number) {
  showEntry(entry); await entry.timer.drain(); entry.timer.reset();
  const cpu: number[] = [], prep: number[] = [], frame: number[] = [], draws: number[] = [], triangles: number[] = [];
  let previous = 0;
  for (let i = -WARMUP; i < SAMPLES; i++) {
    const stamp = await nextFrame();
    if (invalidated || document.hidden) throw new Error('Measurement cancelled: tab visibility, resize or GPU error changed.');
    const step = i < 0 ? (i + WARMUP) * SAMPLES / WARMUP : i;
    const before = performance.now(), expected = pose(view, step); sync(entry);
    const prepared = performance.now() - before;
    entry.renderer.info.reset(); entry.timer.begin(i >= 0 && i % 6 === 0);
    const start = performance.now(); entry.renderer.render(entry.scene, entry.camera); const elapsed = performance.now() - start;
    entry.timer.end();
    const info = entry.renderer.info.render as any, count = entry.kind === 'legacy' ? info.calls : info.drawCalls;
    // The node renderer applies output color conversion in one fullscreen
    // triangle pass. Count that actual cost, while asserting equal terrain.
    const outputPass = entry.kind === 'legacy' ? 0 : 1;
    if (count !== expected.draws + outputPass || info.triangles !== expected.triangles + outputPass) {
      throw new Error(`Draw mismatch: ${count}/${expected.draws + outputPass}; triangles ${info.triangles}/${expected.triangles + outputPass}`);
    }
    if (i >= 0) { cpu.push(elapsed); prep.push(prepared); draws.push(count); triangles.push(info.triangles); if (i > 0) frame.push(stamp - previous); }
    previous = stamp;
  }
  await entry.timer.drain();
  const row = { backend: entry.kind, view, round, cpu: summary(cpu), preparation: summary(prep),
    frame: summary(frame), gpu: summary(entry.timer.values), draws: summary(draws), triangles: summary(triangles),
    outputConversionPasses: entry.kind === 'legacy' ? 0 : 1 };
  results.rows.push(row); showResults();
}

function checkCounts(entry: Entry, expected: { draws: number; triangles: number }) {
  const info = entry.renderer.info.render as any;
  const calls = entry.kind === 'legacy' ? info.calls : info.drawCalls;
  const output = entry.kind === 'legacy' ? 0 : 1;
  if (calls !== expected.draws + output || info.triangles !== expected.triangles + output) {
    throw new Error(`Unequal terrain workload: ${entry.kind}, ${calls} draws / ${info.triangles} triangles`);
  }
}
function replaceTile(entry: Entry, tile: VoxelLodTile) {
  const index = tileIndices.get(tileKey(tile));
  if (index === undefined) throw new Error(`Unexpected tile ${tileKey(tile)}`);
  const mesh = entry.meshes[index];
  mesh.geometry.dispose(); mesh.geometry = geometry(tile); entry.tiles[index] = tile;
  entry.bounds[index].set(new THREE.Vector3(tile.bounds[0], tile.bounds[1], tile.bounds[2]), tile.bounds[3]);
}
function resetTiles(entry: Entry) {
  for (let i = 0; i < tiles.length; i++) if (entry.tiles[i] !== tiles[i]) replaceTile(entry, tiles[i]);
}
function setSize(entry: Entry, width: number, height: number) {
  entry.renderer.setSize(width, height, false);
  entry.target.setSize(width, height);
  const actual = entry.renderer.getDrawingBufferSize(new THREE.Vector2());
  if (actual.x !== width || actual.y !== height) throw new Error(`Unexpected drawing buffer ${actual.x}x${actual.y}`);
}
function checkMeasurement() {
  if (invalidated || document.hidden) throw new Error('Measurement cancelled by visibility, resize or GPU failure.');
}
async function finishGpu(entry: Entry) {
  // Notification/polling overhead is part of the separately labelled batch
  // measurement. Never use this fence in animation-loop timing.
  const deadline = performance.now() + 15000;
  if (entry.kind === 'webgpu') {
    let complete = false;
    const promise = ((entry.renderer as WebGPURenderer).backend as any).device.queue.onSubmittedWorkDone()
      .then(() => { complete = true; });
    while (!complete) { if (performance.now() > deadline) throw new Error('GPU completion timeout'); await delay(0); }
    await promise;
  } else {
    const gl = entry.kind === 'legacy' ? (entry.renderer as THREE.WebGLRenderer).getContext() as WebGL2RenderingContext
      : ((entry.renderer as WebGPURenderer).backend as any).gl as WebGL2RenderingContext;
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!; gl.flush();
    try {
      for (;;) {
        const state = gl.clientWaitSync(fence, 0, 0);
        if (state === gl.ALREADY_SIGNALED || state === gl.CONDITION_SATISFIED) break;
        if (state === gl.WAIT_FAILED || performance.now() > deadline) throw new Error('WebGL completion fence failed');
        await delay(0);
      }
    } finally { gl.deleteSync(fence); }
  }
}
async function measureExtended(entry: Entry, view: View, round: number, width: number, height: number) {
  resetTiles(entry); setSize(entry, width, height); showEntry(entry);
  await entry.timer.drain(); entry.timer.reset();
  const count = view === 'uploads' ? 780 : 450;
  const cpuTotal: number[] = [], cpuSubmit: number[] = [], cpuPrepare: number[] = [],
    frameIntervals: number[] = [], callbackIntervals: number[] = [], publications: number[] = [], uploadMs: number[] = [];
  const longTasks: { startTime: number; duration: number }[] = [];
  const observer = PerformanceObserver.supportedEntryTypes.includes('longtask') ? new PerformanceObserver(list => {
    for (const item of list.getEntries()) longTasks.push({ startTime: item.startTime, duration: item.duration });
  }) : null;
  observer?.observe({ type: 'longtask' });
  let previousStamp = 0, previousCallback = 0, startAt = 0, endAt = 0, submittedFaces = 0,
    uploadedSourceBytes = 0, publishedTiles = 0, nextPacket = 0, offset = 0;
  let pending: VoxelLodTile[] = [];
  const pixelCount = width * height;
  try {
    for (let i = -120; i < count; i++) {
      const stamp = await nextFrame(), callbackStart = performance.now(); checkMeasurement();
      if (i === 0) startAt = callbackStart;
      const step = i < 0 ? (i + 120) * count / 120 : i;
      const uploadStart = performance.now(); let bytes = 0;
      if (view === 'uploads' && i >= 0) {
        if (i % 60 === 0 && nextPacket < replayPackets.length) {
          if (offset !== pending.length) throw new Error('Replay publication failed to keep up with the fixed trace');
          pending = replayPackets[nextPacket++].tiles; offset = 0;
        }
        while (offset < pending.length) {
          const tile = pending[offset], size = tile.count * 15;
          if (bytes && bytes + size > 1048576) break;
          replaceTile(entry, tile); bytes += size; offset++; publishedTiles++;
        }
        uploadedSourceBytes += bytes;
      }
      const uploadTime = performance.now() - uploadStart;
      const beforePrepare = performance.now();
      const expected = pose(view === 'uploads' && i < 0 ? 'near' : view, step, count, entry); sync(entry);
      const preparationTime = performance.now() - beforePrepare;
      entry.renderer.info.reset(); entry.timer.begin(i >= 0 && i % 6 === 0);
      const submitStart = performance.now(); entry.renderer.render(entry.scene, entry.camera);
      const submitTime = performance.now() - submitStart;
      entry.timer.end(); checkCounts(entry, expected);
      if (i >= 0) {
        cpuTotal.push(performance.now() - callbackStart); cpuSubmit.push(submitTime); cpuPrepare.push(preparationTime);
        uploadMs.push(uploadTime); publications.push(bytes); submittedFaces += expected.triangles / 2;
        // The first interval measures the warmup/sample boundary; omit it.
        if (i > 0) { frameIntervals.push(stamp - previousStamp); callbackIntervals.push(callbackStart - previousCallback); }
      }
      previousStamp = stamp; previousCallback = callbackStart; endAt = performance.now();
    }
    await entry.timer.drain();
    if (view === 'uploads' && (nextPacket !== replayPackets.length || offset !== pending.length)) throw new Error('Incomplete LOD replay');
    const row = { backend: entry.kind, view, round, width, height, sampleFrames: count,
      cadence: frameMetrics(frameIntervals), callbackCadence: frameMetrics(callbackIntervals),
      cpuTotal: summary(cpuTotal), cpuSubmit: summary(cpuSubmit), cpuPrepare: summary(cpuPrepare),
      gpu: summary(entry.timer.values), publicationMs: summary(uploadMs), publicationSourceBytes: uploadedSourceBytes,
      publishedTiles, submittedFaces, finalResidentFaces: entry.tiles.reduce((n, tile) => n + tile.count, 0),
      longTasks: observer ? longTasks.filter(task => task.startTime >= startAt && task.startTime < endAt) : null,
      memory: { geometryAttributeBytes: entry.meshes.reduce((n, mesh) => n + Object.values(mesh.geometry.attributes).reduce((m, a) => m + a.array.byteLength, 0), 0),
        geometries: entry.renderer.info.memory.geometries, textures: entry.renderer.info.memory.textures,
        nominalCanvasColorBytes: pixelCount * 4,
        nominalInternalNodeColorBytes: entry.kind === 'legacy' ? 0 : pixelCount * 8,
        note: 'Resource accounting only. Excludes driver allocations, depth, swapchain, caches and other renderers; not total GPU memory.' },
      raw: { frameIntervals, callbackIntervals, cpuTotal, cpuSubmit, gpu: [...entry.timer.values], publicationBytes: publications } };
    results.extended.push(row); showResults();
  } finally { observer?.disconnect(); }
}
async function measureCompletedBatches(entry: Entry, view: View, width: number, height: number, round = 1, batchSize = 32) {
  resetTiles(entry); setSize(entry, width, height); showEntry(entry); await entry.timer.drain();
  const values: number[] = [];
  // Compile and settle this path before starting the fence-based workload.
  for (let warm = 0; warm < 30; warm++) {
    await nextFrame(); pose(view, 0, SAMPLES, entry); sync(entry); entry.renderer.render(entry.scene, entry.camera);
  }
  await finishGpu(entry);
  for (let batch = -3; batch < 24; batch++) {
    checkMeasurement(); const start = performance.now();
    for (let frame = 0; frame < batchSize; frame++) {
      const expected = pose(view, 0, SAMPLES, entry); sync(entry); entry.renderer.info.reset();
      entry.renderer.render(entry.scene, entry.camera); checkCounts(entry, expected);
    }
    await finishGpu(entry);
    if (batch >= 0) values.push((performance.now() - start) / batchSize);
  }
  results.completionBatches.push({ backend: entry.kind, view, width, height, batchSize, round,
    millisecondsPerRender: summary(values), rawMillisecondsPerRender: values });
  showResults();
}
async function validateCompletion() {
  results.completionBatches = (results.completionBatches ?? []).filter((row: any) => row.batchSize !== 32);
  for (const [width, height] of [[1280,720],[3840,2160]]) for (const view of ['near','across'] as View[]) {
    for (let round = 1; round <= 2; round++) for (const kind of (round === 1 ? ['legacy','webgpu'] : ['webgpu','legacy']) as Backend[]) {
      status(`GPU completion validation ${width}x${height} / ${view} / round ${round}/2 / ${names[kind]}`);
      await measureCompletedBatches(entries.get(kind)!, view, width, height, round, 32);
    }
  }
  for (const entry of entries.values()) { resetTiles(entry); setSize(entry, WIDTH, HEIGHT); }
  preview(); results.completionValidatedAt = new Date().toISOString(); showResults();
}
async function runExtended() {
  results.extended = []; results.completionBatches = []; results.errors = [];
  results.extendedMethod = {
    scope: 'Whole measured terrain callback + GPU passes + animation-loop cadence + separate GPU-completion batches. Not the complete game.',
    cadence: 'requestAnimationFrame intervals; not actual compositor presentation or input-to-photon latency. Never add CPU and GPU timings.',
    onePercentLow: '1000 divided by the mean of the slowest ceil(N*0.01) frame intervals.',
    resolutions: [[1280,720],[2560,1440],[3840,2160]], warmupFrames: 120, stationaryAndMotionFrames: 450,
    uploads: '12 real planner output packets for 16m steps, replayed every 60 frames with a deterministic 1MiB source-byte publication budget. CPU buffer packing/replacement and GPU upload are timed; worker planning is prepared separately, not concurrent. No fades.',
    allRenderersResident: true, activeRendererOnly: true, gpuSampling: 'one in six frames; async queries; no fence in cadence test',
  };
  // Measure all renderers at the same pixel count and reverse backend order.
  // The existing fallback suite remains available through Run comparison.
  for (const [width, height] of [[1280,720],[2560,1440],[3840,2160]]) {
    for (const view of ['near', 'across', 'motion'] as View[]) for (let round = 1; round <= 2; round++) {
      for (const kind of (round === 1 ? ['legacy', 'webgpu'] : ['webgpu', 'legacy']) as Backend[]) {
        status(`Extended ${width}x${height} / ${view} / round ${round}/2 / ${names[kind]}`);
        await measureExtended(entries.get(kind)!, view, round, width, height);
      }
    }
  }
  for (let round = 1; round <= 2; round++) for (const kind of (round === 1 ? ['legacy','webgpu'] : ['webgpu','legacy']) as Backend[]) {
    status(`Geometry publication / round ${round}/2 / ${names[kind]}`);
    await measureExtended(entries.get(kind)!, 'uploads', round, 2560, 1440);
  }
  await validateCompletion();
  for (const entry of entries.values()) { resetTiles(entry); setSize(entry, WIDTH, HEIGHT); }
  await pixels(); results.completedAt = new Date().toISOString(); showResults();
}
async function capture(entry: Entry) {
  sync(entry); entry.renderer.setRenderTarget(entry.target); entry.renderer.render(entry.scene, entry.camera);
  let bytes: Uint8Array;
  if (entry.kind === 'legacy') {
    bytes = new Uint8Array(WIDTH * HEIGHT * 4);
    (entry.renderer as THREE.WebGLRenderer).readRenderTargetPixels(entry.target, 0, 0, WIDTH, HEIGHT, bytes);
  } else bytes = await (entry.renderer as WebGPURenderer).readRenderTargetPixelsAsync(entry.target, 0, 0, WIDTH, HEIGHT) as Uint8Array;
  entry.renderer.setRenderTarget(null);
  // WebGPU textures have a top-left origin; both WebGL backends have bottom-left.
  if (entry.kind !== 'webgpu') {
    const flipped = new Uint8Array(bytes.length);
    for (let y = 0; y < HEIGHT; y++) flipped.set(bytes.subarray(y * WIDTH * 4, (y + 1) * WIDTH * 4), (HEIGHT - 1 - y) * WIDTH * 4);
    bytes = flipped;
  }
  const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bytes), WIDTH, HEIGHT), 0, 0);
  return { bytes, url: canvas.toDataURL() };
}
function difference(a: Uint8Array, b: Uint8Array) {
  let total = 0, maxChannel = 0, over8 = 0, over32 = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); total += d; pixelMax = Math.max(pixelMax, d); }
    maxChannel = Math.max(maxChannel, pixelMax); if (pixelMax > 8) over8++; if (pixelMax > 32) over32++;
  }
  return { meanRgb: total / (WIDTH * HEIGHT * 3), maxChannel, pixelsOver8Percent: over8 * 100 / (WIDTH * HEIGHT), pixelsOver32Percent: over32 * 100 / (WIDTH * HEIGHT) };
}
async function pixels() {
  $('captures').replaceChildren(); results.pixels = [];
  for (const view of ['near', 'across', 'motion'] as View[]) {
    pose(view, view === 'motion' ? 187 : 0);
    const captures = new Map<Backend, Awaited<ReturnType<typeof capture>>>();
    for (const [kind, entry] of entries) {
      status(`Checking pixels: ${view} / ${names[kind]}...`); await nextFrame();
      const c = await capture(entry); captures.set(kind, c);
      const figure = document.createElement('figure'), img = document.createElement('img'), caption = document.createElement('figcaption');
      img.src = c.url; img.alt = `${view} / ${names[kind]}`; caption.textContent = img.alt; figure.append(img, caption); $('captures').append(figure);
    }
    const reference = captures.get('legacy')!.bytes;
    for (const kind of ['webgpu', 'fallback'] as Backend[]) if (captures.has(kind)) results.pixels.push({ view, backend: kind, ...difference(reference, captures.get(kind)!.bytes) });
    const repeat = await capture(entries.get('legacy')!);
    results.pixels.push({ view, backend: 'legacy-repeat', ...difference(reference, repeat.bytes) });
  }
  showResults(); preview();
}
function preview() {
  const entry = entries.get(($('preview') as HTMLSelectElement).value as Backend); if (!entry) return;
  pose('across', 0); sync(entry); showEntry(entry); entry.renderer.render(entry.scene, entry.camera);
}
function fail(error: unknown) {
  invalidated = true; const message = String(error); results.errors.push(message); status(message); showResults(); console.error(error);
}
async function exclusive(task: () => Promise<void>) {
  if (running) return; running = true; invalidated = false;
  for (const id of ['run', 'extended', 'completion', 'pixels', 'preview']) ($(id) as HTMLButtonElement).disabled = true;
  try { await task(); status('Complete. Results are local; download JSON to retain them.'); }
  catch (error) { fail(error); }
  finally { running = false; for (const id of ['run', 'extended', 'completion', 'pixels', 'preview']) ($(id) as HTMLButtonElement).disabled = false; }
}
async function init() {
  if (!import.meta.env.DEV || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('Local development only.');
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No usable WebGPU adapter.');
  results.adapter = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
    description: adapter.info.description, features: [...adapter.features] };
  const fixture: any = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./VoxelBackendFixtureWorker.ts', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Fixture generation timed out')); }, 180000);
    worker.onmessage = ({ data }) => {
      if (data.progress) status(data.progress);
      else { clearTimeout(timeout); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data); }
    };
    worker.onerror = error => { clearTimeout(timeout); worker.terminate(); reject(new Error(error.message)); };
    worker.postMessage({ area: Number(new URLSearchParams(location.search).get('area') ?? 64), replay: true });
  });
  tiles = fixture.tiles; spheres = tiles.map(t => new THREE.Sphere(new THREE.Vector3(t.bounds[0], t.bounds[1], t.bounds[2]), t.bounds[3]));
  for (let i = 0; i < tiles.length; i++) tileIndices.set(tileKey(tiles[i]), i);
  replayPackets = fixture.replay;
  results.replayPreparation = replayPackets.map(packet => ({ x: packet.x, changedTiles: packet.tiles.length,
    sourceBytes: packet.tiles.reduce((n, tile) => n + tile.count * 15, 0), workerMs: packet.workerMs, faces: packet.faces }));
  results.fixture = { seed: 42, version: 3, repeatedDistrict: [16, 2], zones: 128, tiles: tiles.length,
    ...fixture.stats, uniqueSourceBytes: fixture.uniqueSourceBytes, packedResidentBytes: tiles.reduce((n, t) => n + t.count * 15, 0),
    alignedAttributeBytesPerBackend: tiles.reduce((n, t) => n + t.count * 32, 0) };
  $('fixture').textContent = `${results.fixture.faces.toLocaleString()} resident faces / ${tiles.length} tiles / ${(results.fixture.packedResidentBytes / 1048576).toFixed(1)} MiB packed source attributes. GPU allocation can differ by backend. Three.js r${THREE.REVISION}.`;
  for (const kind of ['legacy', 'webgpu', 'fallback'] as Backend[]) {
    const entry = await makeEntry(kind); pose('across', 0); sync(entry); showEntry(entry);
    const start = performance.now();
    await entry.renderer.compileAsync(entry.scene, entry.camera);
    entry.renderer.render(entry.scene, entry.camera);
    results.backends[kind].firstCompileAndSubmitMs = performance.now() - start;
    await nextFrame();
  }
  if (results.errors.length) throw new Error('Initialization recorded GPU errors; fix them before benchmarking.');
  const savedMode = new URLSearchParams(location.search).get('saved');
  if (savedMode === '1' || savedMode === 'validated') {
    const file = savedMode === 'validated' ? 'results/webgpu-extended-validated-2026-10-03.json'
      : 'results/webgpu-extended-2026-10-03.json';
    const url = savedMode === 'validated'
      ? new URL('./results/webgpu-extended-validated-2026-10-03.json', import.meta.url)
      : new URL('./results/webgpu-extended-2026-10-03.json', import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error('Saved extended measurements could not be loaded');
    const saved = await response.json();
    for (const key of ['extended', 'completionBatches', 'extendedMethod', 'pixels', 'completionValidatedAt']) results[key] = saved[key];
    results.loadedMeasurement = { startedAt: saved.startedAt, completedAt: saved.completedAt,
      originalMeasurement: saved.loadedMeasurement, file };
  }
  preview(); showResults(); status('Ready. Run comparison or check pixels.');
  for (const id of ['run', 'extended', 'completion', 'pixels', 'preview']) ($(id) as HTMLButtonElement).disabled = false;
}
$('extended').onclick = () => exclusive(runExtended);
$('completion').onclick = () => exclusive(validateCompletion);
$('run').onclick = () => exclusive(async () => {
  results.rows = []; results.errors = [];
  for (const view of ['near', 'across', 'motion'] as View[]) for (let round = 1; round <= 2; round++) {
    const order: Backend[] = round === 1 ? ['legacy', 'webgpu', 'fallback'] : ['fallback', 'webgpu', 'legacy'];
    for (const kind of order) { status(`Measuring ${view}, round ${round}/2: ${names[kind]}. Keep this tab visible.`); await measure(entries.get(kind)!, view, round); }
  }
  await pixels();
});
$('pixels').onclick = () => exclusive(pixels);
$('preview').onchange = preview;
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url;
  a.download = results.extended?.length ? 'space-webgpu-extended.json' : 'space-webgpu-benchmark.json';
  a.click(); URL.revokeObjectURL(url);
};
document.addEventListener('visibilitychange', () => { if (running) invalidated = true; });
window.addEventListener('resize', () => { if (running) invalidated = true; });
window.addEventListener('error', event => fail(event.message));
window.addEventListener('unhandledrejection', event => fail(event.reason));
void init().catch(fail);
