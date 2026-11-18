import * as THREE from 'three/webgpu';
import { clamp, dot, max, texture, vec3, vec4 } from 'three/tsl';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { VOXEL_EMISSIVE_INTENSITY } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import { EMISSIVE_BLOOM_PRESETS, type EmissiveBloomQuality } from './EmissiveBloomQuality.ts';
import type { SpaceRenderer } from './SpaceRenderer.ts';

export class BoundedBloom extends BloomNode {
  maxSize = 2560;

  constructor(input: THREE.Node<'vec4'>, strength: number) {
    super(input, strength, .15, 0);
    // Screenshots and entry warm-up can draw a fresh scene within the same animation frame.
    this.updateBeforeType = THREE.NodeUpdateType.RENDER;
  }

  override setSize(width: number, height: number) {
    const scale = Math.min(1, this.maxSize / Math.max(width, height));
    super.setSize(Math.max(64, Math.round(width * scale)), Math.max(64, Math.round(height * scale)));
  }
}

export function emissiveCoverage(sceneColor: THREE.Node<'vec4'>) {
  return clamp(sceneColor.a.sub(1), 0, 1);
}

export function emissiveBloomColor(sceneColor: THREE.Node<'vec4'>) {
  const color = sceneColor.rgb;
  const luminance = dot(color, vec3(.2126, .7152, .0722));
  return color.mul(VOXEL_EMISSIVE_INTENSITY).div(max(luminance, .000001)).mul(emissiveCoverage(sceneColor));
}

/** Selective HDR bloom for the standard lighting presets. */
export class EmissiveBloom {
  readonly sceneTarget: THREE.RenderTarget;
  private readonly bloom: BoundedBloom;
  private readonly pipeline: THREE.RenderPipeline;
  private readonly size = new THREE.Vector2();
  private readonly renderer: SpaceRenderer;

  constructor(renderer: SpaceRenderer) {
    this.renderer = renderer;
    this.sceneTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: renderer.samples });
    this.sceneTarget.texture.name = 'Space.EmissiveBloom.SceneHDR';
    this.sceneTarget.texture.userData.voxelEmissionMask = true;

    const sceneColor = texture(this.sceneTarget.texture);
    this.bloom = new BoundedBloom(vec4(emissiveBloomColor(sceneColor), 1), 1);
    this.pipeline = new THREE.RenderPipeline(renderer, vec4(sceneColor.rgb.add(this.bloom.rgb), 1));
  }

  setQuality(quality: Exclude<EmissiveBloomQuality, 'off'>) {
    const preset = EMISSIVE_BLOOM_PRESETS[quality];
    this.bloom.strength.value = preset.strength;
    this.bloom.maxSize = preset.maxSize;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const renderer = this.renderer;
    renderer.getDrawingBufferSize(this.size);
    this.sceneTarget.setSize(this.size.x, this.size.y);
    const previousTarget = renderer.getRenderTarget();
    const { autoClear, toneMapping, outputColorSpace } = renderer;
    const xrEnabled = renderer.xr.enabled;
    try {
      renderer.autoClear = true;
      renderer.setRenderTarget(this.sceneTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previousTarget);
      this.pipeline.render();
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = autoClear;
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = outputColorSpace;
      renderer.xr.enabled = xrEnabled;
    }
  }

  dispose() {
    this.pipeline.dispose();
    this.bloom.dispose();
    this.sceneTarget.dispose();
  }
}
