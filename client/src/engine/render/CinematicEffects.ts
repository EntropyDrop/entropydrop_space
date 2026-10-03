import * as THREE from 'three/webgpu';
import { Fn, If, Loop, Continue, uv, texture, uniform, vec2, vec3, vec4, float, int,
  max, min, abs, dot, cross, mix, clamp, smoothstep, exp, exp2, log2, pow, sin, cos, sqrt, floor, fract, renderOutput } from 'three/tsl';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { SpaceRenderer } from './SpaceRenderer.ts';
import { VOXEL_EMISSIVE_INTENSITY } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';

class BoundedBloom extends BloomNode {
  setSize(width: number, height: number) {
    const scale = Math.min(1, 2560 / Math.max(width, height));
    super.setSize(Math.max(64, Math.round(width * scale)), Math.max(64, Math.round(height * scale)));
  }
}
const fullscreen = (node: any, name: string) => {
  const material = Object.assign(new THREE.NodeMaterial(), { name, depthTest: false, depthWrite: false, toneMapped: false });
  material.fragmentNode = node;
  return material;
};

/** Native WebGPU HDR chain; depth reconstruction uses WebGPU's [0,1] clip Z. */
export class CinematicEffects {
  readonly sceneTarget = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1,1,THREE.UnsignedIntType),
  });
  readonly atmosphereTarget = new THREE.RenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false});
  readonly secondaryTarget = new THREE.RenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false,
    minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
  readonly displayTarget = new THREE.RenderTarget(1,1,{depthBuffer:false});
  readonly resolution = uniform(new THREE.Vector2(1,1));
  readonly secondaryResolution = uniform(new THREE.Vector2(1,1));
  readonly inverseProjection = uniform(new THREE.Matrix4());
  readonly cameraWorld = uniform(new THREE.Matrix4());
  readonly surfaceUp = uniform(new THREE.Vector3(0,1,0));
  readonly sunDirection = uniform(new THREE.Vector3(0,1,0));
  readonly sunUv = uniform(new THREE.Vector2());
  readonly sunVisibility = uniform(0);
  readonly secondaryEffects = uniform(1);
  readonly atmosphere: THREE.NodeMaterial;
  readonly secondary: THREE.NodeMaterial;
  readonly output: THREE.NodeMaterial;
  readonly bloom: BoundedBloom;
  readonly antialias: ReturnType<typeof fxaa>;
  private readonly quad = new THREE.QuadMesh();
  private pipeline: THREE.RenderPipeline | null = null;
  private secondaryScale = .5;
  private readonly size = new THREE.Vector2();
  private readonly projectedSun = new THREE.Vector3();
  private disposed = false;

  constructor() {
    this.sceneTarget.texture.name = 'Space.Ultra.SceneHDR';
    this.sceneTarget.texture.userData.voxelEmissionMask = true;
    this.atmosphereTarget.texture.name = 'Space.Ultra.AtmosphereHDR';
    this.secondaryTarget.texture.name = 'Space.Ultra.Secondary';
    this.displayTarget.texture.name = 'Space.Ultra.Display';
    const colorAt = (point: any) => texture(this.sceneTarget.texture, point);
    const depthAt = (point: any) => texture(this.sceneTarget.depthTexture!, point).r;
    const positionAt = (point: any) => {
      // Texture UV is top-left in WebGPU; the camera projection's Y points up.
      const clip = vec4(point.x.mul(2).sub(1), point.y.mul(-2).add(1), depthAt(point), 1);
      const p = this.inverseProjection.mul(clip);
      return p.xyz.div(p.w);
    };
    const inBounds = (point: any) => point.x.greaterThanEqual(0).and(point.y.greaterThanEqual(0))
      .and(point.x.lessThanEqual(1)).and(point.y.lessThanEqual(1));
    const contact = (center: any) => Fn(() => {
      const result = float(1).toVar();
      If(center.z.negate().greaterThanEqual(.8).and(center.z.negate().lessThanEqual(180)), () => {
        const texel = vec2(1).div(this.resolution);
        const l = positionAt(uv().sub(vec2(texel.x,0))), r = positionAt(uv().add(vec2(texel.x,0)));
        const b = positionAt(uv().add(vec2(0,texel.y))), t = positionAt(uv().sub(vec2(0,texel.y)));
        const dx = abs(l.z.sub(center.z)).lessThan(abs(r.z.sub(center.z))).select(center.sub(l),r.sub(center));
        const dy = abs(b.z.sub(center.z)).lessThan(abs(t.z.sub(center.z))).select(center.sub(b),t.sub(center));
        const normal = cross(dx,dy).add(vec3(0,0,.0000001)).normalize();
        const pixels = clamp(float(1.3).mul(this.resolution.y).div(center.z.negate().mul(vec4(this.inverseProjection.element(int(1))).y).mul(2)),2,72);
        const occlusion = float(0).toVar();
        Loop(16, ({i}) => {
          const angle = float(i).mul(2.399963), ring = sqrt(float(i).add(.5).div(16));
          const sampleUv = uv().add(vec2(cos(angle),sin(angle)).mul(ring).mul(pixels).mul(texel));
          If(inBounds(sampleUv).and(depthAt(sampleUv).lessThan(.999999)), () => {
            const p = positionAt(sampleUv), delta = p.sub(center), distance = delta.length();
            If(p.z.negate().greaterThanEqual(.8), () => {
              occlusion.addAssign(max(dot(normal,delta.div(max(distance,.0001))).sub(.2),0)
                .mul(smoothstep(.15,1.3,distance).oneMinus()));
            });
          });
        });
        result.assign(clamp(occlusion.mul(2/16).oneMinus(),.6,1));
      });
      return result;
    })();
    const shafts = Fn(() => {
      const illumination = float(0).toVar();
      If(this.sunVisibility.greaterThan(0), () => {
        const step = this.sunUv.sub(uv()).mul(.94/24), p = uv().toVar(), decay = float(1).toVar();
        Loop(24, () => {
          p.addAssign(step);
          If(inBounds(p), () => {
            const sky = depthAt(p).greaterThanEqual(.999999).select(1,0);
            const proximity = max(p.sub(this.sunUv).mul(vec2(this.resolution.x.div(this.resolution.y),1)).length().div(.85).oneMinus(),0);
            const transmission = smoothstep(.3,1.4,dot(colorAt(p).rgb,vec3(.2126,.7152,.0722)));
            illumination.addAssign(sky.mul(proximity).mul(proximity).mul(decay).mul(transmission));
          });
          decay.mulAssign(.965);
        });
      });
      return illumination.mul(.014).mul(this.sunVisibility);
    })();
    this.secondary = fullscreen(Fn(() => {
      const p = positionAt(uv());
      return vec4(depthAt(uv()).lessThan(.999999).select(contact(p),1), shafts, log2(max(p.z.negate(),0).add(1)),1);
    })(), 'Space.Ultra.Secondary');
    const secondaryAt = (position: any) => Fn(() => {
      const grid = uv().mul(this.secondaryResolution).sub(.5), base = floor(grid), fraction = fract(grid);
      const depth = log2(max(position.z.negate(),0).add(1));
      const ao = float(0).toVar(), weight = float(0).toVar(), shaft = float(0).toVar();
      for(let y=0;y<2;y++) for(let x=0;x<2;x++) {
        const offset = vec2(x,y), effect = texture(this.secondaryTarget.texture,base.add(offset).add(.5).div(this.secondaryResolution)).rgb;
        const blend = fraction.oneMinus().mul(offset.oneMinus()).add(fraction.mul(offset)), spatial = blend.x.mul(blend.y);
        const bilateral = spatial.mul(exp2(abs(effect.b.sub(depth)).mul(-128)));
        ao.addAssign(effect.r.mul(bilateral)); weight.addAssign(bilateral); shaft.addAssign(effect.g.mul(spatial));
      }
      return vec2(weight.greaterThan(.0001).select(ao.div(max(weight,.0001)),1),shaft);
    })();
    this.atmosphere = fullscreen(Fn(() => {
      const scene = colorAt(uv()), color = scene.rgb.toVar(), coverage = clamp(scene.a.sub(1),0,1);
      const p = positionAt(uv()).toVar(), ray = this.cameraWorld.mul(vec4(p,0)).xyz.normalize();
      const effects = this.secondaryEffects.greaterThan(.5).select(secondaryAt(p),vec2(1,0));
      If(depthAt(uv()).lessThan(.999999).and(p.z.negate().greaterThan(.8)), () => {
        color.mulAssign(mix(effects.x,1,coverage));
        const distance = p.length(), elevation = dot(ray,this.surfaceUp);
        const mist = exp(max(elevation.mul(distance).add(12),0).mul(-.012));
        const haze = exp(distance.mul(mist.mul(.0005).add(.00012)).negate()).oneMinus().mul(.32);
        const hazeColor = mix(vec3(.24,.40,.62),vec3(.78,.58,.38),pow(max(dot(ray,this.sunDirection),0),8));
        color.assign(mix(color,hazeColor,haze.mul(coverage.oneMinus())));
      });
      const luminance = dot(color,vec3(.2126,.7152,.0722)).toVar();
      color.assign(mix(vec3(luminance),color,1.12));
      color.mulAssign(mix(vec3(.91,.97,1.06),vec3(1.035,1.015,.96),smoothstep(.05,.9,luminance)));
      If(p.z.negate().greaterThan(.8), () => { color.addAssign(vec3(1,.72,.38).mul(effects.y).mul(coverage.oneMinus())); });
      return vec4(max(color,vec3(0)),1);
    })(), 'Space.Ultra.Atmosphere');
    const scene = colorAt(uv()), atmosphere = texture(this.atmosphereTarget.texture);
    const coverage = clamp(scene.a.sub(1),0,1);
    const emission = scene.rgb.mul(VOXEL_EMISSIVE_INTENSITY).div(max(dot(scene.rgb,vec3(.2126,.7152,.0722)),.000001));
    const extracted = mix(vec4(0),atmosphere,smoothstep(1.5,1.51,dot(atmosphere.rgb,vec3(.2126,.7152,.0722))));
    this.bloom = new BoundedBloom(mix(extracted,vec4(emission,1),coverage),.06,.15,0);
    this.output = fullscreen(Fn(() => {
      const color = renderOutput(vec4(atmosphere.rgb.add(this.bloom.rgb),1),THREE.AgXToneMapping,THREE.SRGBColorSpace).rgb.toVar();
      color.assign(clamp(color.sub(.5).mul(1.08).add(.5),0,1));
      color.assign(mix(vec3(dot(color,vec3(.2126,.7152,.0722))),color,1.12));
      const edge = uv().mul(2).sub(1);
      color.mulAssign(dot(edge,edge).mul(.035).oneMinus());
      return vec4(clamp(color,0,1),1);
    })(), 'Space.Ultra.Output');
    this.antialias = fxaa(texture(this.displayTarget.texture));
  }

  setSize(width: number, height: number) {
    const scale = Math.min(1,2560/Math.max(width,height));
    width = Math.max(64,Math.round(width*scale)); height = Math.max(64,Math.round(height*scale));
    this.secondaryTarget.setSize(Math.ceil(width*this.secondaryScale),Math.ceil(height*this.secondaryScale));
    this.secondaryResolution.value.set(this.secondaryTarget.width,this.secondaryTarget.height);
    for(const target of [this.sceneTarget,this.atmosphereTarget,this.displayTarget]) target.setSize(width,height);
    this.resolution.value.set(width,height);
  }
  setSecondaryResolutionScale(scale: .5 | 1) { this.secondaryScale=scale; this.setSize(this.sceneTarget.width,this.sceneTarget.height); }
  getSecondaryResolutionScale() { return this.secondaryScale; }
  render(renderer: SpaceRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
    sunDirection: THREE.Vector3, surfaceUp: THREE.Vector3, fullEffects: boolean) {
    renderer.getDrawingBufferSize(this.size); this.setSize(this.size.x,this.size.y);
    this.inverseProjection.value.copy(camera.projectionMatrixInverse); this.cameraWorld.value.copy(camera.matrixWorld);
    this.surfaceUp.value.copy(surfaceUp); this.sunDirection.value.copy(sunDirection); this.secondaryEffects.value=fullEffects?1:0;
    this.projectedSun.copy(camera.position).addScaledVector(sunDirection,1000).applyMatrix4(camera.matrixWorldInverse);
    if(this.projectedSun.z<-.001) {
      this.projectedSun.applyMatrix4(camera.projectionMatrix);
      this.sunUv.value.set(this.projectedSun.x*.5+.5,.5-this.projectedSun.y*.5);
      this.sunVisibility.value=1-THREE.MathUtils.smoothstep(Math.max(Math.abs(this.projectedSun.x),Math.abs(this.projectedSun.y)),.9,1.6);
    } else { this.sunUv.value.set(.5,.5); this.sunVisibility.value=0; }
    const previous=renderer.getRenderTarget(), autoClear=renderer.autoClear;
    const toneMapping=renderer.toneMapping, outputColorSpace=renderer.outputColorSpace;
    try {
      renderer.autoClear=true; renderer.setRenderTarget(this.sceneTarget); renderer.render(scene,camera);
      const draw=(target: THREE.RenderTarget, material: THREE.NodeMaterial) => { renderer.setRenderTarget(target); this.quad.material=material; this.quad.render(renderer); };
      if(fullEffects) draw(this.secondaryTarget,this.secondary);
      // The atmosphere graph still binds this texture when its contribution
      // is disabled. Refresh storage after a resize even if its pass is skipped.
      else renderer.initRenderTarget(this.secondaryTarget);
      draw(this.atmosphereTarget,this.atmosphere); draw(this.displayTarget,this.output);
      this.pipeline ??= new THREE.RenderPipeline(renderer,this.antialias);
      this.pipeline.outputColorTransform=false;
      renderer.setRenderTarget(previous); this.pipeline.render();
    } finally { renderer.setRenderTarget(previous); renderer.autoClear=autoClear; renderer.toneMapping=toneMapping; renderer.outputColorSpace=outputColorSpace; }
  }
  dispose() {
    if(this.disposed) return; this.disposed=true;
    this.sceneTarget.depthTexture?.dispose();
    for(const target of [this.sceneTarget,this.atmosphereTarget,this.secondaryTarget,this.displayTarget]) target.dispose();
    for(const material of [this.atmosphere,this.secondary,this.output]) material.dispose();
    this.bloom.dispose(); this.pipeline?.dispose();
  }
}
