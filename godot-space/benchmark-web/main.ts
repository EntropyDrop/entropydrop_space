import * as THREE from 'three/webgpu';

const status = document.querySelector<HTMLPreElement>('#status')!;
const panel = document.querySelector<HTMLDivElement>('#panel')!;
const run = document.querySelector<HTMLButtonElement>('#run')!;
const download = document.querySelector<HTMLButtonElement>('#download')!;
const renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: true });
renderer.setPixelRatio(1);
renderer.setSize(1280, 720);
renderer.setClearColor(0x91b1c9);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.body.prepend(renderer.domElement);
await renderer.init();
if (!(renderer.backend as any).isWebGPUBackend) throw new Error('WebGPU required; fallback is not a valid comparison.');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1280 / 720, .1, 600);
camera.position.set(.5, 150, 140);
camera.lookAt(0, 70, 0);
const manifest = await fetch('../baked/manifest.json').then(r => r.json());
const bytes = await fetch('../baked/surfaces.bin').then(r => r.arrayBuffer());
const material = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
for (const surface of manifest.surfaces) {
  const geometry = new THREE.BufferGeometry();
  const n = surface.vertices, o = surface.offset;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bytes, o, n * 3), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(bytes, o + n * 12, n * 4), 4));
  const indices = new Uint32Array(bytes, o + n * 28, surface.indices);
  // Godot's front faces are clockwise; Three's are counterclockwise.
  const reversed = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) { reversed[i] = indices[i]; reversed[i + 1] = indices[i + 2]; reversed[i + 2] = indices[i + 1]; }
  geometry.setIndex(new THREE.BufferAttribute(reversed, 1));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);
}
await renderer.compileAsync(scene, camera);
status.textContent = `${manifest.meshes} chunks · ${manifest.triangles.toLocaleString()} triangles\nReady. Keep this tab visible during measurement.`;
run.disabled = false;
const summary = (values: number[]) => {
  if (!values.length) return { available: false };
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  const tail = sorted.slice(-Math.max(1, Math.ceil(n * .01)));
  return { available: true, count: n, mean: values.reduce((a, b) => a + b, 0) / n,
    p50: sorted[Math.floor((n - 1) * .5)], p95: sorted[Math.floor((n - 1) * .95)], p99: sorted[Math.floor((n - 1) * .99)], max: sorted[n - 1],
    slowestOnePercentMean: tail.reduce((a, b) => a + b, 0) / tail.length };
};
let active: any = null, latest: any = null, pendingGpu = false;
function start() {
  if (active || document.visibilityState !== 'visible') throw new Error('Keep the tab visible; only one benchmark can run.');
  active = { start: performance.now(), last: 0, frames: [], cpu: [], gpu: [], hidden: false, maxDrawCalls: 0, maxPrimitives: 0 };
  panel.style.display = 'none';
}
document.addEventListener('visibilitychange', () => { if (active && document.hidden) active.hidden = true; });
run.onclick = start;
download.onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'three-webgpu-aether.json'; a.click(); URL.revokeObjectURL(url);
};
(window as any).aetherBenchmark = { start, get result() { return latest; }, manifest, renderer, camera };
renderer.setAnimationLoop(() => {
  const now = performance.now();
  if (active) {
    const elapsed = (now - active.start) / 1000, t = Math.max(0, elapsed - 8);
    camera.position.set(60 * Math.sin(t * 2 * Math.PI / 24), 150 + 15 * Math.sin(t * 2 * Math.PI / 16), 110 + 30 * Math.cos(t * 2 * Math.PI / 24));
    camera.lookAt(0, 70, 0);
    if (elapsed >= 8 && active.last) active.frames.push(now - active.last);
    active.last = now;
  }
  const began = performance.now();
  renderer.render(scene, camera);
  if (!pendingGpu) {
    pendingGpu = true;
    const sample = active;
    renderer.resolveTimestampsAsync().then(() => {
      const ms = renderer.info.render.timestamp;
      if (sample && sample === active && now - sample.start >= 8000 && ms > 0) sample.gpu.push(ms);
    }).finally(() => { pendingGpu = false; });
  }
  if (active && now - active.start >= 8000) {
    active.cpu.push(performance.now() - began);
    active.maxDrawCalls = Math.max(active.maxDrawCalls, renderer.info.render.drawCalls);
    active.maxPrimitives = Math.max(active.maxPrimitives, renderer.info.render.triangles);
  }
  if (active && now - active.start >= 32000) {
    const frames = summary(active.frames);
    latest = { backend: 'Three.js WebGPU', threeRevision: THREE.REVISION, utc: new Date().toISOString(), userAgent: navigator.userAgent,
      resolution: [1280, 720], warmupSeconds: 8, durationSeconds: 24, fov: 70,
      sourceSha256: manifest.sourceSha256, meshes: manifest.meshes, triangles: manifest.triangles, lighting: manifest.lighting,
      projection: 'flat', browserFramePacing: 'requestAnimationFrame; may be refresh-rate limited', visibilityLost: active.hidden,
      frameMs: frames, renderSubmitMs: summary(active.cpu), renderGpuMs: summary(active.gpu), fps: 1000 / frames.mean!, onePercentLowFps: 1000 / frames.slowestOnePercentMean!,
      maxDrawCalls: active.maxDrawCalls, maxPrimitives: active.maxPrimitives, rawFrameMs: active.frames };
    active = null;
    panel.style.display = '';
    status.textContent = JSON.stringify(latest, null, 2);
    void fetch('/__benchmark_result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(latest) })
      .then(r => { if (!r.ok) throw new Error('Automatic local save failed; use Download results.'); })
      .catch(error => console.warn(error));
    download.disabled = false;
  }
});
