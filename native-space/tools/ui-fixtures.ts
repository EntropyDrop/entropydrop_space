import { writeFileSync } from 'node:fs';
import { computeSelectionCells, type SelectorShape, type StairsOrientation } from '../../client/src/engine/controls/SelectorShapes.ts';
import { normalizeGradientStops, sampleGradientColor } from '../../engine/src/voxel/Palette.ts';
import { RESERVED_ENTITY_INPUT_CODES } from '../../client/src/engine/controls/ControlBindings.ts';
const shapes: unknown[] = [];
const point = (v: number[]) => ({ x:v[0], y:v[1], z:v[2] });
for (const shape of ['box','cylinder','sphere','stairs','line'] as SelectorShape[]) {
  for (const [a,b] of [[[0,0,0],[0,0,0]],[[-3,-2,-1],[2,3,4]],[[4,3,2],[-2,1,-4]],[[0,5,0],[0,0,6]]]) {
    for (const axis of ['x','y','z'] as const) {
      const cells = computeSelectionCells(shape, point(a), point(b), false, axis).map(p => [p.x,p.y,p.z]);
      shapes.push({shape, a,b, axis:['x','y','z'].indexOf(axis), cells});
    }
  }
}
for (const runAxis of ['x','y','z'] as const) for (const riseAxis of ['x','y','z'] as const) {
  if (runAxis===riseAxis) continue;
  for (const runDirection of [1,-1] as const) for (const riseDirection of [1,-1] as const) {
    const stairs:StairsOrientation = {runAxis,riseAxis,runDirection,riseDirection};
    const a=[-2,1,3],b=[3,5,6];
    shapes.push({shape:'stairs',a,b,axis:1,stairs:{run:['x','y','z'].indexOf(runAxis),rise:['x','y','z'].indexOf(riseAxis),run_direction:runDirection,rise_direction:riseDirection},
      cells:computeSelectionCells('stairs',point(a),point(b),false,'y',undefined,stairs).map(p=>[p.x,p.y,p.z])});
  }
}
const palettes = [[{color:'#ff0000',position:0},{color:'#0000ff',position:1}],
  [{color:'#123456',position:.5},{color:'#ffffff',position:.5},{color:'#000000',position:1}],
  [{color:'#48dbfb',position:0}],
  [{color:'#f2a93b',position:1},{color:'#abcdef',position:0},{color:'#0f0f0f',position:.333}]].map(source=>{
    const stops=normalizeGradientStops(source);return {stops:stops.map(s=>({color_rgb:parseInt(s.color.slice(1),16),offset_millis:Math.round(s.position*1000)})),
      samples:[-1,0,.01,.2,.333,.5,.77,.999,1,2].map(t=>({t,color:sampleGradientColor(stops,t)}))};
  });
writeFileSync(new URL('../tests/fixtures/ui.json',import.meta.url),JSON.stringify({shapes,palettes,reserved:[...RESERVED_ENTITY_INPUT_CODES]})+'\n');
