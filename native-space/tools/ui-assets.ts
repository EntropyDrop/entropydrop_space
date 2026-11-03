// Build-time conversion only. The desktop never executes Web UI code.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {runtimeEntityToPortable,encodeInventoryResource} from '../../engine/src/storage/InventoryProtobuf.ts';
const root=resolve(import.meta.dirname,'..');
const level=JSON.parse(readFileSync(resolve(root,'../client/src/tutorial/tutorial-level.json'),'utf8'));
mkdirSync(resolve(root,'assets/tutorial'),{recursive:true});
const entities=level.entities.entities.map((e:any)=>{
  const resource=encodeInventoryResource('entity',runtimeEntityToPortable({...e.slot,blocks:e.slot.blocks.map((b:any)=>{const x=Math.round(b.localX*8),y=Math.round(b.localY*8),z=Math.round(b.localZ*8);return {...b,dx:Math.floor(x/8),dy:Math.floor(y/8),dz:Math.floor(z/8),...(b.size<1?{mx:((x%8)+8)%8,my:((y%8)+8)%8,mz:((z%8)+8)%8}:{} )};})}));
  writeFileSync(resolve(root,`assets/tutorial/${e.publicId}.edpb`),resource);
  return {id:e.publicId,position:e.constructorOrigin,rotation:e.quaternion,file:`${e.publicId}.edpb`};
});
writeFileSync(resolve(root,'assets/tutorial/level.json'),JSON.stringify({spawn:level.spawn,terrain:level.terrain,entities}));
