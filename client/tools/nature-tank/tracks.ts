import type { DecorationDefinition } from '../../../engine/src/contraption/Decorations.ts';

export const wheelZ = [-3.125, -1, 1, 3.125];
export const parkedLength = .75;
export const trackRadius = .955;
export const shoesPerSide = 32;

export function trackPath(lengths: number[]) {
  const points: [number, number][] = [];
  for(let i=0;i<4;i++) points.push([wheelZ[i],-lengths[i]+trackRadius]);
  for(let j=1;j<=8;j++) {
    const a=j*Math.PI/8;
    points.push([wheelZ[3]+trackRadius*Math.sin(a),-lengths[3]+trackRadius*Math.cos(a)]);
  }
  for(let i=2;i>=0;i--) points.push([wheelZ[i],-lengths[i]-trackRadius]);
  for(let j=1;j<=8;j++) {
    const a=j*Math.PI/8;
    points.push([wheelZ[0]-trackRadius*Math.sin(a),-lengths[0]-trackRadius*Math.cos(a)]);
  }
  return points;
}

export function createTracks(): DecorationDefinition[] {
  const points=trackPath(Array(4).fill(parkedLength));
  const segments=points.slice(1).map((p,i)=>Math.hypot(p[0]-points[i][0],p[1]-points[i][1]));
  const perimeter=segments.reduce((a,b)=>a+b,0), decorations: DecorationDefinition[]=[];
  for(let side=0;side<2;side++) for(let i=0;i<shoesPerSide;i++) {
    let distance=(i+.5)*perimeter/shoesPerSide,k=0;
    while(k<segments.length-1&&distance>segments[k]) distance-=segments[k++];
    const a=points[k],b=points[k+1],t=distance/segments[k];
    const angle=-Math.atan2(b[1]-a[1],b[0]-a[0]);
    decorations.push({id:`track_${side}_${i}`,position:[side===0?-1.875:1.875,a[1]+(b[1]-a[1])*t,a[0]+(b[0]-a[0])*t],
      rotation:[Math.sin(angle/2),0,0,Math.cos(angle/2)],scale:[.9,.16,perimeter/shoesPerSide*.94],
      color:i%4===0?0x69716b:0x353e39});
  }
  return decorations;
}
