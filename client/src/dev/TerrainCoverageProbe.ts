import * as THREE from 'three/webgpu';
import { floor, texture, uv, varying, vec2, vec4 } from 'three/tsl';
import { terrainCoverage } from '@entropydrop/space-engine/render/NodeMaterials.ts';
import { TerrainHandoff } from '@entropydrop/space-engine/render/TerrainHandoff.ts';
if (!import.meta.env.DEV || location.hostname !== 'localhost' || !/Firefox\//.test(navigator.userAgent)) throw Error('Local native Firefox only');
const status = document.querySelector('#status')!;
const renderer = new THREE.WebGPURenderer({ antialias: false });
renderer.setSize(256, 128); renderer.toneMapping = THREE.NoToneMapping;
document.body.append(renderer.domElement);
const handoff = new TerrainHandoff(), target = new THREE.RenderTarget(256, 128, { samples: 0 });
target.texture.colorSpace = THREE.NoColorSpace;
const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10);
camera.position.z = 1;
const geometry = new THREE.PlaneGeometry(2, 2), mesh = new THREE.Mesh(geometry); scene.add(mesh);
const cases = [
  { name: 'face ends at next chunk', from: [8192, 1024.25], size: [16, 0] },
  { name: 'face spans several chunks', from: [8184, 1024.25], size: [48, 0] },
  { name: 'negative major-ring seam', from: [-16, 1024.25], size: [32, 0] },
  { name: 'positive major-ring seam', from: [16368, 1024.25], size: [32, 0] },
  { name: 'tube seam', from: [8192.25, 2032], size: [0, 32] },
  { name: 'side-face owner offset', from: [8208 - .01, 1024], size: [0, 16] },
];
const index = (x: number, z: number) => (((Math.floor(z / 16) % 128 + 128) % 128) * 1024 + (Math.floor(x / 16) % 1024 + 1024) % 1024) * 2;
for (let z = 0; z < 128; z++) for (let x = 0; x < 1024; x++) {
  handoff.data[(z * 1024 + x) * 2] = (x + z) % 2 ? 255 : 0;
  handoff.data[(z * 1024 + x) * 2 + 1] = (x * 3 + z) % 5 === 0 ? 255 : 0;
}
handoff.texture.needsUpdate = true;
const result: any = { userAgent: navigator.userAgent, width: 256, height: 128, cases: [], errors: [] };
try {
  await renderer.init(); (renderer.backend as any).device.addEventListener('uncapturederror', (e: any) => result.errors.push(e.error.message));
  for (const item of cases) {
    const flat = uv().mul(vec2(...item.size as [number, number])).add(vec2(...item.from as [number, number]));
    for (const legacy of [true, false]) {
      const chunk = varying(floor(flat.mod(vec2(16384, 2048)).add(vec2(16384, 2048)).mod(vec2(16384, 2048)).div(16)));
      const sampled = legacy ? texture(handoff.texture, chunk.add(.5).div(vec2(1024, 128))).rg : terrainCoverage(handoff.texture, flat);
      const material = new THREE.MeshBasicNodeMaterial(); material.outputNode = vec4(sampled, 0, 1); material.toneMapped = false;
      mesh.material = material; renderer.setRenderTarget(target); renderer.render(scene, camera);
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 128);
      let wrongPixels = 0;
      for (let y = 0; y < 128; y++) for (let x = 0; x < 256; x++) {
        const at = (y * 256 + x) * 4;
        const owner = index(item.from[0] + (x + .5) / 256 * item.size[0], item.from[1] + (1 - (y + .5) / 128) * item.size[1]);
        if (Math.abs(Number(pixels[at]) - handoff.data[owner]) > 1 || Math.abs(Number(pixels[at + 1]) - handoff.data[owner + 1]) > 1) wrongPixels++;
      }
      result.cases.push({ name: item.name, legacy, wrongPixels, pixels: 256 * 128 }); material.dispose();
    }
  }
  result.passed = !result.errors.length && result.cases.filter((v: any) => !v.legacy).every((v: any) => v.wrongPixels === 0)
    && result.cases.some((v: any) => v.legacy && v.wrongPixels > 0);
  const response = await fetch('http://127.0.0.1:54388/firefox/aether-archipelago/coverage-probe.json', { method: 'POST', body: JSON.stringify(result) });
  if (!response.ok) throw Error('Probe result save failed');
  status.textContent = JSON.stringify(result, null, 2); document.title = result.passed ? 'Coverage GPU probe: passed' : 'Coverage GPU probe: FAILED';
} catch (error) { status.textContent = String(error); document.title = 'Coverage GPU probe: FAILED'; }
finally { renderer.setRenderTarget(null); target.dispose(); geometry.dispose(); handoff.texture.dispose(); renderer.dispose(); }
