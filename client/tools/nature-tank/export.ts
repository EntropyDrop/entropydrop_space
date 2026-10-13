import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createTank,createCourse,anchor,courseOrigin } from './model.ts';
import { encodeInventoryResource,decodeInventoryResource } from '../../../engine/src/storage/InventoryProtobuf.ts';
import { compileEntityScript } from '../../../engine/src/scripting/AssemblyScriptCompiler.ts';
const model=createTank(),nodes=[model.root,...model.root.children],course=createCourse();
await compileEntityScript(model.root.script!);
const occupied=new Set<string>();
for(const node of nodes) for(const b of node.blocks) {
  const p=node===model.root?model.root.pivot!.map(v=>-v):node.localPosition||[0,0,0],n=b.size===.125?1:8;
  assert(p.every(v=>Math.abs(v*8-Math.round(v*8))<1e-8),'Stopped component is off the construction grid: '+node.id);
  for(let x=0;x<n;x++) for(let y=0;y<n;y++) for(let z=0;z<n;z++) {
    const key=[b.dx*8+(b.mx||0)+x+p[0]*8,b.dy*8+(b.my||0)+y+p[1]*8,b.dz*8+(b.mz||0)+z+p[2]*8].join(',');
    assert(!occupied.has(key),'Overlapping authored voxel '+key);occupied.add(key);
  }
}
const total=nodes.reduce((s,n)=>s+n.blocks.length,0);assert(total<=65536);assert(course.blocks.length<=1024);
const localOutput = new URL('../../../.local/nature-vehicle-exports/nature-tank/', import.meta.url);
await mkdir(localOutput, { recursive: true });
for(const [name,kind,data] of [['tank','entity',model],['course','blockset',course]] as const) {
  const bytes=encodeInventoryResource(kind,data as never),decoded=decodeInventoryResource(bytes,kind);
  await writeFile(new URL('./'+name+'.pb',import.meta.url),bytes);
  await writeFile(new URL(name+'.json',localOutput),JSON.stringify(decoded.portable));
}
const stats={anchor,courseOrigin,components:nodes.length,voxels:total,
  standardVoxels:nodes.flatMap(n=>n.blocks).filter(b=>b.size!==.125).length,decorations:model.root.decorations?.length,
  seats:model.root.seats.length,scripts:1,maxRaysPerTick:64,physics:'dynamic hull; eight spring-damper contacts; two articulated tread loops',
  wheelRadius:.875,trackOuterRadius:1.035,suspensionRestLength:1.25,springNPerM:16000,dampingNsPerM:2300,
  courseBlocks:course.blocks.length,stepHeightM:1,stepZ:[634,637],floorTopY:25,stepTopY:26};
await writeFile(new URL('model-stats.json',localOutput),JSON.stringify(stats,null,2)+'\n');
console.log(JSON.stringify(stats));
