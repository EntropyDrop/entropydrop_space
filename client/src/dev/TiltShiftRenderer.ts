import {
  HalfFloatType, NodeMaterial, QuadMesh, RenderTarget, Vector2,
} from 'three/webgpu';
import {
  abs, float, mix, renderOutput, screenUV, smoothstep, texture, uniform, vec2,
} from 'three/tsl';
import { interceptMethod } from './FrameDiagnostics.ts';

function material(name: string) {
  const result = new NodeMaterial();
  result.name = name;
  result.depthTest = false;
  result.depthWrite = false;
  result.toneMapped = false;
  return result;
}

/** Reuses Three r183's existing HDR scene pass and replaces its output conversion
 * with the composite. The blur adds two quarter-width/height texture passes. */
export function createTiltShiftRenderer(scene: any) {
  const renderer = scene.renderer;
  if (typeof renderer._renderOutput !== 'function' || typeof renderer._renderScene !== 'function')
    throw new Error('Unsupported Three output pipeline.');
  const horizontal = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  const vertical = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  horizontal.texture.name = 'TiltShift.Horizontal';
  vertical.texture.name = 'TiltShift.Vertical';
  const horizontalMaterial = material('TiltShift horizontal');
  const verticalMaterial = material('TiltShift vertical');
  const outputMaterial = material('TiltShift composite');
  const hQuad = new QuadMesh(horizontalMaterial);
  const vQuad = new QuadMesh(verticalMaterial);
  const outputQuad = new QuadMesh(outputMaterial);
  const blurResolution = uniform(new Vector2(1, 1));
  let sharpSource: RenderTarget | undefined;
  let enabled = false;
  let worldPass = false;

  function blur(source: any, axis: any) {
    const step = axis.div(blurResolution).mul(1.85);
    const input = texture(source, screenUV);
    const sample = (offset: number) => input.sample(screenUV.add(step.mul(offset)));
    return input.mul(0.2270270270)
      .add(sample(1.3846153846).add(sample(-1.3846153846)).mul(0.3162162162))
      .add(sample(3.2307692308).add(sample(-3.2307692308)).mul(0.0702702703));
  }

  function prepare(source: RenderTarget) {
    if (sharpSource === source) return;
    sharpSource = source;
    horizontalMaterial.fragmentNode = blur(source.texture, vec2(1, 0));
    verticalMaterial.fragmentNode = blur(horizontal.texture, vec2(0, 1));
    const focalLine = float(0.56).add(screenUV.x.sub(0.5).mul(0.12));
    const weight = smoothstep(0.10, 0.35, abs(screenUV.y.sub(focalLine)));
    const composite = mix(texture(source.texture, screenUV), texture(vertical.texture, screenUV), weight);
    outputMaterial.fragmentNode = renderOutput(composite, renderer.toneMapping, renderer.currentColorSpace);
    for (const shader of [horizontalMaterial, verticalMaterial, outputMaterial]) shader.needsUpdate = true;
  }

  const restoreWorld = interceptMethod(scene, 'renderWorld', (original, args) => {
    worldPass = true;
    try { return original(...args); }
    finally { worldPass = false; }
  });
  const restoreOutput = interceptMethod(renderer, '_renderOutput', (original, [source]) => {
    if (!enabled || !worldPass) return original(source);
    prepare(source);
    const width = Math.ceil(source.width / 4), height = Math.ceil(source.height / 4);
    if (horizontal.width !== width || horizontal.height !== height) {
      horizontal.setSize(width, height);
      vertical.setSize(width, height);
      blurResolution.value.set(width, height);
    }
    const savedTarget = renderer.getRenderTarget();
    const savedClear = renderer.autoClear;
    const draw = (target: RenderTarget | null, quad: QuadMesh) => {
      renderer.setRenderTarget(target);
      renderer._renderScene(quad, quad.camera, false);
    };
    try {
      renderer.autoClear = true;
      draw(horizontal, hQuad);
      draw(vertical, vQuad);
      renderer.autoClear = false;
      draw(savedTarget, outputQuad);
    } finally {
      renderer.setRenderTarget(savedTarget);
      renderer.autoClear = savedClear;
    }
  });
  return {
    setEnabled(value: boolean) { enabled = value; },
    dispose() {
      restoreOutput();
      restoreWorld();
      horizontal.dispose();
      vertical.dispose();
      for (const shader of [horizontalMaterial, verticalMaterial, outputMaterial]) shader.dispose();
    },
  };
}
