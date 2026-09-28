import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { VOXEL_EMISSIVE_INTENSITY } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const effectUniforms = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform mat4 inverseProjection;
  uniform mat4 cameraWorld;
  uniform vec3 surfaceUp;
  uniform vec3 sunDirection;
  uniform vec2 sunUv;
  uniform float sunVisibility;
  uniform float secondaryEffects;

  vec3 viewPosition(vec2 uv, float depth) {
    vec4 position = inverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return position.xyz / position.w;
  }
`;

const secondaryShader = /* glsl */ `${effectUniforms}
  float contactOcclusion(vec3 center) {
    // Viewmodel geometry is close to the camera. It must neither acquire fog
    // nor cast screen-space occlusion onto terrain metres behind the hand.
    if (-center.z < 0.8 || -center.z > 180.0) return 1.0;
    vec2 texel = 1.0 / resolution;
    vec3 l = viewPosition(vUv - vec2(texel.x, 0.0), texture2D(tDepth, vUv - vec2(texel.x, 0.0)).r);
    vec3 r = viewPosition(vUv + vec2(texel.x, 0.0), texture2D(tDepth, vUv + vec2(texel.x, 0.0)).r);
    vec3 b = viewPosition(vUv - vec2(0.0, texel.y), texture2D(tDepth, vUv - vec2(0.0, texel.y)).r);
    vec3 t = viewPosition(vUv + vec2(0.0, texel.y), texture2D(tDepth, vUv + vec2(0.0, texel.y)).r);
    vec3 dx = abs(l.z - center.z) < abs(r.z - center.z) ? center - l : r - center;
    vec3 dy = abs(b.z - center.z) < abs(t.z - center.z) ? center - b : t - center;
    vec3 normal = normalize(cross(dx, dy) + vec3(0.0, 0.0, 0.0000001));
    float radius = 1.3;
    float pixels = clamp(radius * resolution.y / (-center.z * inverseProjection[1][1] * 2.0), 2.0, 72.0);
    float occlusion = 0.0;
    for (int i = 0; i < 16; i++) {
      float angle = float(i) * 2.399963;
      float ring = sqrt((float(i) + 0.5) / 16.0);
      vec2 sampleUv = vUv + vec2(cos(angle), sin(angle)) * ring * pixels * texel;
      if (any(lessThan(sampleUv, vec2(0.0))) || any(greaterThan(sampleUv, vec2(1.0)))) continue;
      float depth = texture2D(tDepth, sampleUv).r;
      if (depth >= 0.999999) continue;
      vec3 samplePosition = viewPosition(sampleUv, depth);
      if (-samplePosition.z < 0.8) continue;
      vec3 delta = samplePosition - center;
      float distanceToSample = length(delta);
      float horizon = max(dot(normal, delta / max(distanceToSample, 0.0001)) - 0.2, 0.0);
      occlusion += horizon * (1.0 - smoothstep(0.15, radius, distanceToSample));
    }
    return clamp(1.0 - occlusion * 2.0 / 16.0, 0.6, 1.0);
  }

  float sunlightShafts() {
    if (sunVisibility <= 0.0) return 0.0;
    vec2 stepUv = (sunUv - vUv) * (0.94 / 24.0);
    vec2 sampleUv = vUv;
    float illumination = 0.0;
    float decay = 1.0;
    for (int i = 0; i < 24; i++) {
      sampleUv += stepUv;
      if (all(greaterThanEqual(sampleUv, vec2(0.0))) && all(lessThanEqual(sampleUv, vec2(1.0)))) {
        float sky = step(0.999999, texture2D(tDepth, sampleUv).r);
        float proximity = max(1.0 - length((sampleUv - sunUv) * vec2(resolution.x / resolution.y, 1.0)) / 0.85, 0.0);
        // Dark cloud silhouettes also block light even though sky has no depth.
        vec3 sampleColor = texture2D(tColor, sampleUv).rgb;
        float cloudTransmission = smoothstep(0.3, 1.4, dot(sampleColor, vec3(0.2126, 0.7152, 0.0722)));
        illumination += sky * proximity * proximity * decay * cloudTransmission;
      }
      decay *= 0.965;
    }
    return illumination * (0.014 * sunVisibility);
  }

  void main() {
    float depth = texture2D(tDepth, vUv).r;
    vec3 position = viewPosition(vUv, depth);
    float occlusion = depth < 0.999999 ? contactOcclusion(position) : 1.0;
    // Log depth survives half-float storage even at the far end of the ring.
    // Emission and viewmodel masking happen at full resolution on composition.
    gl_FragColor = vec4(occlusion, sunlightShafts(), log2(1.0 + max(-position.z, 0.0)), 1.0);
  }
`;

const atmosphereShader = /* glsl */ `${effectUniforms}
  uniform sampler2D tSecondary;
  uniform vec2 secondaryResolution;

  vec2 secondaryAt(vec3 position) {
    // Gather the four low-resolution texels explicitly. Bilateral AO weights
    // prevent a foreground edge from darkening the background or the hand.
    vec2 grid = vUv * secondaryResolution - 0.5;
    vec2 base = floor(grid), fraction = fract(grid);
    float centerDepth = log2(1.0 + max(-position.z, 0.0));
    float ao = 0.0, weight = 0.0, shafts = 0.0;
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec3 sampleEffect = texture2D(tSecondary, (base + offset + 0.5) / secondaryResolution).rgb;
      vec2 blend = mix(1.0 - fraction, fraction, offset);
      float spatial = blend.x * blend.y;
      float bilateral = spatial * exp2(-abs(sampleEffect.b - centerDepth) * 128.0);
      ao += sampleEffect.r * bilateral;
      weight += bilateral;
      shafts += sampleEffect.g * spatial;
    }
    return vec2(weight > 0.0001 ? ao / weight : 1.0, shafts);
  }

  void main() {
    vec4 scene = texture2D(tColor, vUv);
    vec3 color = scene.rgb;
    float emissionCoverage = clamp(scene.a - 1.0, 0.0, 1.0);
    float depth = texture2D(tDepth, vUv).r;
    vec3 position = viewPosition(vUv, depth);
    vec3 ray = normalize(mat3(cameraWorld) * position);
    vec2 effects = secondaryEffects > 0.5 ? secondaryAt(position) : vec2(1.0, 0.0);
    if (depth < 0.999999 && -position.z > 0.8) {
      color *= mix(effects.x, 1.0, emissionCoverage);
      float distanceToCamera = length(position);
      float elevation = dot(ray, surfaceUp);
      float lowMist = exp(-max(elevation * distanceToCamera + 12.0, 0.0) * 0.012);
      // The opposite ring is kilometres away. Preserve at least 68% of its
      // surface color, with gentler haze above the local ground-mist layer.
      float haze = (1.0 - exp(-distanceToCamera * (0.00012 + lowMist * 0.0005))) * 0.32;
      float sunFacing = pow(max(dot(ray, sunDirection), 0.0), 8.0);
      vec3 hazeColor = mix(vec3(0.24, 0.40, 0.62), vec3(0.78, 0.58, 0.38), sunFacing);
      color = mix(color, hazeColor, haze * (1.0 - emissionCoverage));
    }
    // Warm highlights and cool shadows, with restrained extra saturation.
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luminance), color, 1.12);
    color *= mix(vec3(0.91, 0.97, 1.06), vec3(1.035, 1.015, 0.96), smoothstep(0.05, 0.9, luminance));
    if (-position.z > 0.8) color += vec3(1.0, 0.72, 0.38) * effects.y * (1.0 - emissionCoverage);
    gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
  }
`;

/**
 * Ultra-only HDR chain. Depth comes from the actual bent scene, so AO and haze
 * also work with the sphere/ring shader and newly constructed voxel entities.
 * There is no override-normal render that would flatten the curved world.
 */
export class CinematicEffects {
  readonly sceneTarget: THREE.WebGLRenderTarget;
  readonly atmosphereTarget: THREE.WebGLRenderTarget;
  readonly secondaryTarget: THREE.WebGLRenderTarget;
  readonly displayTarget: THREE.WebGLRenderTarget;
  readonly atmosphere: THREE.ShaderMaterial;
  readonly secondary: THREE.ShaderMaterial;
  readonly bloom: UnrealBloomPass;
  readonly output = new OutputPass();
  readonly antialias = new FXAAPass();
  private readonly quad: FullScreenQuad;
  private readonly secondaryQuad: FullScreenQuad;
  private secondaryScale = 0.5;
  private readonly size = new THREE.Vector2();
  private readonly projectedSun = new THREE.Vector3();
  private disposed = false;

  constructor() {
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.sceneTarget.texture.name = 'Space.Ultra.SceneHDR';
    this.sceneTarget.texture.userData.voxelEmissionMask = true;
    this.atmosphereTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.atmosphereTarget.texture.name = 'Space.Ultra.AtmosphereHDR';
    this.secondaryTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.secondaryTarget.texture.name = 'Space.Ultra.Secondary';
    this.displayTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.displayTarget.texture.name = 'Space.Ultra.Display';
    this.atmosphere = new THREE.ShaderMaterial({
      name: 'Space.Ultra.Atmosphere', vertexShader, fragmentShader: atmosphereShader,
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        tColor: { value: this.sceneTarget.texture },
        tDepth: { value: this.sceneTarget.depthTexture },
        resolution: { value: new THREE.Vector2(1, 1) },
        inverseProjection: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
        surfaceUp: { value: new THREE.Vector3(0, 1, 0) },
        sunDirection: { value: new THREE.Vector3(0, 1, 0) },
        sunUv: { value: new THREE.Vector2() },
        sunVisibility: { value: 0 },
        secondaryEffects: { value: 1 },
        tSecondary: { value: this.secondaryTarget.texture },
        secondaryResolution: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.secondary = new THREE.ShaderMaterial({
      name: 'Space.Ultra.Secondary', vertexShader, fragmentShader: secondaryShader,
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: this.atmosphere.uniforms,
    });
    this.quad = new FullScreenQuad(this.atmosphere);
    this.secondaryQuad = new FullScreenQuad(this.secondary);
    // Bloom belongs to emissive voxels, the sun and bright cloud rims; lit terrain
    // must retain its albedo instead of bleeding a white glow across the ring.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(64, 64), 0.06, 0.15, 1.5);
    // Extract voxel glow from surface radiance and HDR emission coverage.
    // This keeps dark/red/blue tints glowing with a restrained halo intensity
    // or letting atmosphere grading change the hue of the bloom source.
    this.bloom.materialHighPassFilter.uniforms.tVoxelScene = { value: this.sceneTarget.texture };
    this.bloom.materialHighPassFilter.fragmentShader = this.bloom.materialHighPassFilter.fragmentShader
      .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse;\nuniform sampler2D tVoxelScene;')
      .replace('gl_FragColor = mix( outputColor, texel, alpha );', `
        vec4 scene = texture2D(tVoxelScene, vUv);
        float coverage = clamp(scene.a - 1.0, 0.0, 1.0);
        float brightness = dot(scene.rgb, vec3(0.2126, 0.7152, 0.0722));
        vec3 emission = scene.rgb * (${VOXEL_EMISSIVE_INTENSITY.toFixed(1)} / max(brightness, 0.000001));
        gl_FragColor = mix(mix(outputColor, texel, alpha), vec4(emission, 1.0), coverage);`);
    // Grade after tone mapping so the high dynamic range does not turn into a
    // grey veil. Emissive cores and halos pass through the same soft highlight
    // mapping; restoring original RGB here would cut a dark hole in the glow.
    this.output.material.fragmentShader = this.output.material.fragmentShader
      .replace(/\n\s*}\s*$/, `
       vec3 color = gl_FragColor.rgb;
       color = clamp((color - 0.5) * 1.08 + 0.5, 0.0, 1.0);
       float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
       color = mix(vec3(luminance), color, 1.12);
       vec2 edge = vUv * 2.0 - 1.0;
       color *= 1.0 - dot(edge, edge) * 0.035;
       gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }`);
    this.antialias.material.toneMapped = false;
    this.antialias.material.depthTest = false;
    this.antialias.material.depthWrite = false;
    this.antialias.renderToScreen = true;
  }

  setSize(width: number, height: number) {
    // Bound HDR memory independently of display DPI. The canvas/UI stay native.
    const scale = Math.min(1, 2560 / Math.max(width, height));
    width = Math.max(64, Math.round(width * scale));
    height = Math.max(64, Math.round(height * scale));
    this.secondaryTarget.setSize(Math.ceil(width * this.secondaryScale), Math.ceil(height * this.secondaryScale));
    this.atmosphere.uniforms.secondaryResolution.value.set(this.secondaryTarget.width, this.secondaryTarget.height);
    if (this.sceneTarget.width === width && this.sceneTarget.height === height) return;
    for (const target of [this.sceneTarget, this.atmosphereTarget, this.displayTarget]) target.setSize(width, height);
    this.atmosphere.uniforms.resolution.value.set(width, height);
    this.bloom.setSize(width, height);
    this.antialias.setSize(width, height);
  }

  /** Full-resolution reference for the development profiler; never persisted. */
  setSecondaryResolutionScale(scale: 0.5 | 1) {
    this.secondaryScale = scale;
    this.setSize(this.sceneTarget.width, this.sceneTarget.height);
  }

  getSecondaryResolutionScale() { return this.secondaryScale; }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
    sunDirection: THREE.Vector3, surfaceUp: THREE.Vector3, fullEffects: boolean) {
    renderer.getDrawingBufferSize(this.size);
    this.setSize(this.size.x, this.size.y);
    const uniforms = this.atmosphere.uniforms;
    uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
    uniforms.cameraWorld.value.copy(camera.matrixWorld);
    uniforms.surfaceUp.value.copy(surfaceUp);
    uniforms.sunDirection.value.copy(sunDirection);
    uniforms.secondaryEffects.value = fullEffects ? 1 : 0;
    this.projectedSun.copy(camera.position).addScaledVector(sunDirection, 1000).applyMatrix4(camera.matrixWorldInverse);
    if (this.projectedSun.z < -0.001) {
      this.projectedSun.applyMatrix4(camera.projectionMatrix);
      uniforms.sunUv.value.set(this.projectedSun.x * 0.5 + 0.5, this.projectedSun.y * 0.5 + 0.5);
      uniforms.sunVisibility.value = 1 - THREE.MathUtils.smoothstep(
        Math.max(Math.abs(this.projectedSun.x), Math.abs(this.projectedSun.y)), 0.9, 1.6);
    } else {
      uniforms.sunUv.value.set(0.5, 0.5);
      uniforms.sunVisibility.value = 0;
    }

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    try {
      // Fullscreen passes leave GPU state behind. Reset before world geometry
      // so rendering remains correct even when the sun shadow pass is disabled.
      renderer.resetState();
      renderer.autoClear = true;
      renderer.setRenderTarget(this.sceneTarget);
      renderer.render(scene, camera);
      if (fullEffects) {
        renderer.setRenderTarget(this.secondaryTarget);
        this.secondaryQuad.render(renderer);
      }
      renderer.setRenderTarget(this.atmosphereTarget);
      this.quad.render(renderer);
      // Bloom adds back into the HDR atmosphere target; tone mapping follows
      // exactly once, before FXAA's sRGB edge detection.
      // Emission is a material property, so Auto must retain its bloom while
      // dropping secondary effects. Its buffers already follow render scale.
      this.bloom.render(renderer, this.sceneTarget, this.atmosphereTarget, 0, false);
      this.output.render(renderer, this.displayTarget, this.atmosphereTarget, 0, false);
      this.antialias.render(renderer, this.displayTarget, this.displayTarget, 0, false);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.sceneTarget.depthTexture?.dispose();
    for (const target of [this.sceneTarget, this.atmosphereTarget, this.secondaryTarget, this.displayTarget]) target.dispose();
    this.atmosphere.dispose();
    this.secondary.dispose();
    this.quad.dispose();
    this.secondaryQuad.dispose();
    this.bloom.dispose();
    this.output.dispose();
    this.antialias.dispose();
  }
}
