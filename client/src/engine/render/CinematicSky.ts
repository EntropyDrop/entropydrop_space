import { BackSide, MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, If, vec2, vec3, vec4, float, uniform, reference, positionGeometry, varying,
  dot, fract, floor, sin, mix, max, pow, smoothstep, clamp } from 'three/tsl';

const cloudHash = (p: any) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const cloudNoise = (point: any) => {
  const p = vec2(point);
  const cell = floor(p), f = fract(p).mul(fract(p)).mul(float(3).sub(fract(p).mul(2)));
  return mix(mix(cloudHash(cell), cloudHash(cell.add(vec2(1,0))), f.x),
    mix(cloudHash(cell.add(vec2(0,1))), cloudHash(cell.add(1)), f.x), f.y);
};
const cloudFbm = (point: any) => Fn(() => {
  const p = point.toVar(), value = float(0).toVar();
  let weight = .5;
  for (let i = 0; i < 5; i++) {
    value.addAssign(cloudNoise(p).mul(weight));
    p.assign(vec2(p.x.mul(1.6).add(p.y.mul(1.2)), p.x.mul(-1.2).add(p.y.mul(1.6))).add(vec2(11.3,7.1)));
    weight *= .5;
  }
  return value;
})();

/** Procedural clouds and both sky quality modes share the scene HDR pipeline. */
export function createSkyMaterial(values: Record<string, { value: any }>) {
  const v = (key: string) => vec3(uniform(values[key].value));
  const f = (key: string) => float(reference('value', 'float', values[key]));
  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const dir = varying(positionGeometry.normalize()).normalize(), sun = v('uSunDir');
    const sunDot = max(dot(dir, sun), 0), height = dot(dir, v('uSurfaceUp'));
    const color = mix(v('uSkyColor'), v('uHoleColor'), smoothstep(.15,.95,dot(dir,v('uHoleDir'))).mul(f('uGradientStrength'))).toVar();
    color.assign(mix(color, v('uLimbColor'), smoothstep(.25,.9,dot(dir,sun)).mul(f('uGradientStrength')).mul(.5)));
    color.addAssign(vec3(1,.78,.48).mul(pow(sunDot,32).add(pow(sunDot,256))).mul(f('uSunGlow')));
    If(f('uCinematic').greaterThan(.5), () => {
      color.assign(mix(vec3(.35,.58,.94), vec3(.018,.09,.34), pow(max(height,0),.45)));
      color.addAssign(vec3(1,.56,.22).mul(pow(sunDot,8)).mul(.26));
      color.addAssign(vec3(1,.69,.35).mul(pow(sunDot,96)).mul(1.35));
      color.addAssign(vec3(1,.86,.59).mul(smoothstep(.99945,.99978,sunDot)).mul(12));
      If(height.greaterThan(.015), () => {
        const time = f('uTime'), east = v('uEast'), north = v('uNorth');
        const wind = vec2(time.mul(.008), time.mul(.003));
        const uv = vec2(dot(dir,east),dot(dir,north)).div(max(height,.015)).mul(1.65).add(wind).toVar();
        const broad = cloudNoise(uv.mul(.42).add(13));
        const density = cloudFbm(uv).mul(.78).add(broad.mul(.22)).toVar();
        const cloud = smoothstep(.48,.69,density).mul(smoothstep(.08,.24,height));
        const lit = cloudFbm(uv.add(vec2(dot(sun,east),dot(sun,north)).mul(.16))).mul(.78).add(broad.mul(.22));
        const silver = clamp(density.sub(lit).mul(7).add(.35),0,1);
        const cloudColor = mix(vec3(.38,.49,.65),vec3(1.3,1.26,1.16),silver)
          .add(vec3(1,.69,.36).mul(pow(sunDot,16)).mul(cloud.oneMinus()).mul(.8));
        color.assign(mix(color,cloudColor,cloud.mul(.96)));
        const wisps = smoothstep(.62,.79,cloudFbm(uv.mul(vec2(.5,2.4)).add(wind.mul(.6)).add(29)));
        color.assign(mix(color,vec3(1.25,1.3,1.4),wisps.mul(.22).mul(smoothstep(.08,.3,height))));
      });
    });
    return color;
  })();
  return material;
}
