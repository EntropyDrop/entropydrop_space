import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createChinook, anchor } from './model.ts';
import { encodeInventoryResource, decodeInventoryResource } from '../../../engine/src/storage/InventoryProtobuf.ts';
import { compileEntityScript } from '../../../engine/src/scripting/AssemblyScriptCompiler.ts';

const model=createChinook(),nodes=[model.root,...model.root.children];
const occupied=new Set<string>();
for (const node of nodes) {
  await compileEntityScript(node.script!);
  const p=node.localPosition||[0,0,0];
  for (const b of node.blocks) {
    const micro=b.size===.125, n=micro?1:8;
    for(let x=0;x<n;x++) for(let y=0;y<n;y++) for(let z=0;z<n;z++) {
      const key=[b.dx*8+(b.mx||0)+x+p[0]*8,b.dy*8+(b.my||0)+y+p[1]*8,b.dz*8+(b.mz||0)+z+p[2]*8].join(',');
      assert(!occupied.has(key),`Overlapping authored voxel ${key} in ${node.id}`);
      occupied.add(key);
    }
  }
}
const total=nodes.reduce((sum,n)=>sum+n.blocks.length,0);
assert(total<=65536,'Entity voxel quota');
const bytes=encodeInventoryResource('entity',model),decoded=decodeInventoryResource(bytes,'entity');
assert.equal(decoded.portable.root.children.length,2);
const localOutput = new URL('../../../.local/nature-vehicle-exports/nature-chinook/', import.meta.url);
await mkdir(localOutput, { recursive: true });
await writeFile(new URL('./ch47.entity.pb',import.meta.url),bytes);
await writeFile(new URL('ch47.json',localOutput),JSON.stringify(decoded.portable));
const stats={anchor,bytes:bytes.length,components:nodes.length,voxels:total,
  standardVoxels:nodes.flatMap(n=>n.blocks).filter(b=>b.size!==.125).length,
  decorations:0,compiledScripts:nodes.length,nonoverlapping:true,
  perComponent:nodes.map(n=>({id:n.id,voxels:n.blocks.length}))};
await writeFile(new URL('model-stats.json',localOutput),JSON.stringify(stats,null,2)+'\n');
console.log(JSON.stringify(stats));
