import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const atmosphereShader = /* glsl */ `
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

  vec3 sunlightShafts() {
    if (sunVisibility <= 0.0) return vec3(0.0);
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
    return vec3(1.0, 0.72, 0.38) * illumination * (0.014 * sunVisibility);
  }

  void main() {
    vec3 color = texture2D(tColor, vUv).rgb;
    float depth = texture2D(tDepth, vUv).r;
    vec3 position = viewPosition(vUv, depth);
    vec3 ray = normalize(mat3(cameraWorld) * position);
    if (depth < 0.999999 && -position.z > 0.8) {
      if (secondaryEffects > 0.5) color *= contactOcclusion(position);
      float distanceToCamera = length(position);
      float elevation = dot(ray, surfaceUp);
      float lowMist = exp(-max(elevation * distanceToCamera + 12.0, 0.0) * 0.012);
      // The opposite ring is kilometres away. Preserve at least 68% of its
      // surface color, with gentler haze above the local ground-mist layer.
      float haze = (1.0 - exp(-distanceToCamera * (0.00012 + lowMist * 0.0005))) * 0.32;
      float sunFacing = pow(max(dot(ray, sunDirection), 0.0), 8.0);
      vec3 hazeColor = mix(vec3(0.24, 0.40, 0.62), vec3(0.78, 0.58, 0.38), sunFacing);
      color = mix(color, hazeColor, haze);
    }
    // Warm highlights and cool shadows, with restrained extra saturation.
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luminance), color, 1.12);
    color *= mix(vec3(0.91, 0.97, 1.06), vec3(1.035, 1.015, 0.96), smoothstep(0.05, 0.9, luminance));
    if (secondaryEffects > 0.5 && -position.z > 0.8) color += sunlightShafts();
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
  readonly displayTarget: THREE.WebGLRenderTarget;
  readonly atmosphere: THREE.ShaderMaterial;
  readonly bloom: UnrealBloomPass;
  readonly output = new OutputPass();
  readonly antialias = new FXAAPass();
  private readonly quad: FullScreenQuad;
  private readonly size = new THREE.Vector2();
  private readonly projectedSun = new THREE.Vector3();
  private disposed = false;

  constructor() {
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.sceneTarget.texture.name = 'Space.Ultra.SceneHDR';
    this.atmosphereTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.atmosphereTarget.texture.name = 'Space.Ultra.AtmosphereHDR';
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
      },
    });
    this.quad = new FullScreenQuad(this.atmosphere);
    // Bloom belongs to the sun and bright cloud rims; ordinary lit terrain
    // must retain its albedo instead of bleeding a white glow across the ring.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(64, 64), 0.16, 0.35, 2.2);
    // Grade after tone mapping so the high dynamic range does not turn into a
    // grey veil. Keep a soft shoulder for the sun and illuminated cloud rims.
    this.antialias.material.fragmentShader = this.antialias.material.fragmentShader.replace(
      'gl_FragColor = ApplyFXAA( tDiffuse, resolution.xy, vUv );',
      `vec3 color = ApplyFXAA(tDiffuse, resolution.xy, vUv).rgb;
       color = clamp((color - 0.5) * 1.08 + 0.5, 0.0, 1.0);
       float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
       color = mix(vec3(luminance), color, 1.12);
       vec2 edge = vUv * 2.0 - 1.0;
       color *= 1.0 - dot(edge, edge) * 0.035;
       gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);`,
    );
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
    if (this.sceneTarget.width === width && this.sceneTarget.height === height) return;
    for (const target of [this.sceneTarget, this.atmosphereTarget, this.displayTarget]) target.setSize(width, height);
    this.atmosphere.uniforms.resolution.value.set(width, height);
    this.bloom.setSize(width, height);
    this.antialias.setSize(width, height);
  }

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
      renderer.setRenderTarget(this.atmosphereTarget);
      this.quad.render(renderer);
      // Bloom adds back into the HDR atmosphere target; tone mapping follows
      // exactly once, before FXAA's sRGB edge detection.
      if (fullEffects) this.bloom.render(renderer, this.sceneTarget, this.atmosphereTarget, 0, false);
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
    for (const target of [this.sceneTarget, this.atmosphereTarget, this.displayTarget]) target.dispose();
    this.atmosphere.dispose();
    this.quad.dispose();
    this.bloom.dispose();
    this.output.dispose();
    this.antialias.dispose();
  }
}
