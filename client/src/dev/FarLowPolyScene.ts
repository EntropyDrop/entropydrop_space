/** Explicit offline-only integration trial. Normal game animation and PBR stay active. */
import * as THREE from 'three/webgpu';
import { attribute, varying, vec4, reference, output } from 'three/tsl';
import { createVoxelEmissionMaskUniform, voxelEmissionColor } from '@entropydrop/space-engine/render/VoxelEmission.ts';
import { bendTorusPoint } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { corners, include, distanceToBounds, meshBrick, simplifyMesh, MeshoptSimplifier, type Brick, type MeshPart } from './FarLowPolyData.ts';
import { interceptMethod } from './FrameDiagnostics.ts';

if (import.meta.hot) import.meta.hot.accept();
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const empty = () => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

export async function createFarLowPolyScene(game:any, pixels=.5) {
  if (!import.meta.env.DEV || !game.offline) throw new Error('Offline DEV fixture required.');
  const scene=game.sceneRenderer,layer=game.world.distantSurface.voxels,arena=layer.arena;
  if (!arena || layer.hasPendingWork || layer.hasPendingTransitions) throw new Error('Wait for settled far geometry.');
  if (scene.scene.getObjectByName('FarLowPolyScene')) throw new Error('Dispose the existing scene trial first.');
  const initial=game.playerPhysics.position.clone(),camera=bendTorusPoint(initial.x,initial.y,initial.z).toArray();
  const focal=1440/(2*Math.tan(scene.camera.fov*Math.PI/360));
  let suspended=false,enabled=false,closed=false;
  const resume=interceptMethod(game,'animate',()=>{suspended=true;});
  while(!suspended) await frame();
  const note=document.createElement('p');note.id='lowpoly-scene-status';note.style.cssText='position:fixed;bottom:12px;left:12px;z-index:12000;background:#14202c;color:white;padding:8px';
  document.body.append(note);
  const group=new THREE.Group();group.name='FarLowPolyScene';group.visible=false;
  const material=new THREE.MeshStandardNodeMaterial({flatShading:true,roughness:.65,metalness:.15});
  const color=attribute<'vec4'>('lowpolyColor','vec4'),emissionMask=createVoxelEmissionMaskUniform(material);
  material.colorNode=color.xyz;
  material.outputNode=varying(color.a).greaterThan(.5).select(vec4(voxelEmissionColor(color.xyz),reference('value','float',emissionMask).add(1)),output);
  const resources:THREE.BufferGeometry[]=[],undo:(()=>void)[]=[];
  type Source={entry:any;geometry:any;count:number;versions:number[];bricks:{bounds:number[];start:number;count:number}[]};
  const sources:Source[]=[],chosen=new Map<any,Source>();
  const stats={pixels,minimumDistance:384,movementLimit:64,selectedFaces:0,bricks:0,triangles:0,vertices:0,bytes:0,
    buildMs:0,refreshes:0,refreshMs:0,visibleTriangles:0,fallbackSources:0,seamFallbacks:0};
  const parts:(MeshPart&{emissive:boolean})[]=[];let indexOffset=0;
  try {
    await MeshoptSimplifier.ready;const started=performance.now(),point=new THREE.Vector3();
    const entries=arena.pages.flatMap((p:any)=>[...p.entries]);
    for(let ei=0;ei<entries.length;ei++){
      const entry:any=entries[ei],a=entry.page.data.array as Uint32Array,o=entry.origin;
      if(entry.copied!==entry.count || entry.attributes)throw new Error('Incomplete source migration.');
      const bounds=empty(),bricks=new Map<string,Brick&{emissive:boolean}>();
      for(let i=0;i<entry.count;i++){
        const at=(entry.start+i)*4,dir=(a[at+2]>>>16)&255;
        const emissive=(a[at+2]>>>24)!==0;
        const q:Brick['quads'][number]=[o.x+(a[at]&65535)/8,o.y+(a[at]>>>16)/8,o.z+(a[at+1]&65535)/8,
          (a[at+1]>>>16)/8,(a[at+2]&65535)/8,dir,a[at+3]];
        const cs=corners(q),axis=dir>>1,sign=(dir&1)?1:-1;
        const origin=[0,1,2].map(d=>Math.floor(((cs[0][d]+cs[2][d])*.5-(d===axis?sign*.001:0))/64)*64),key=`${origin.join(',')}/${emissive}`;
        let brick=bricks.get(key);if(!brick){brick={key,origin,quads:[],bounds:empty(),emissive};bricks.set(key,brick);}brick.quads.push(q);
        for(const c of cs){bendTorusPoint(c[0],c[1],c[2],point);include(bounds,point.toArray());include(brick.bounds,point.toArray());}
      }
      // Replace whole source entries so no partial packed block is lost.
      // Emission classes are reduced separately; masked sources retain production draws.
      if(distanceToBounds(camera,bounds)<384)continue;
      const source:Source={entry,geometry:entry.geometry,count:entry.count,versions:[...entry.versions],bricks:[]};
      for(const brick of bricks.values()){
        const prepared=meshBrick(brick,true);
        for(let i=0;i<prepared.positions.length;i+=3)include(brick.bounds,prepared.positions.subarray(i,i+3));
        const part=simplifyMesh(prepared,pixels*Math.max(1,distanceToBounds(camera,brick.bounds)-80)/focal);
        source.bricks.push({bounds:brick.bounds,start:indexOffset,count:part.indices.length});indexOffset+=part.indices.length;
        stats.bricks++;stats.vertices+=part.vertices.byteLength/16;stats.seamFallbacks+=Number(part.seamFallback);parts.push({...part,emissive:brick.emissive});
      }
      stats.selectedFaces+=entry.count;sources.push(source);chosen.set(entry,source);
      if(ei%16===0){note.textContent=`Preparing ${pixels} px scene meshes: ${ei}/${entries.length} sources`;await frame();}
    }
    if(!sources.length)throw new Error('No eligible far sources.');
    const vertices=new Uint8Array(stats.vertices*16),colors=new Uint8Array(stats.vertices*4),allIndices=new Uint32Array(indexOffset);let vo=0,io=0;
    for(const part of parts){vertices.set(part.vertices,vo);for(let i=0;i<part.vertices.byteLength/16;i++){const c=vo/4+i*4;colors.set(part.vertices.subarray(i*16+12,i*16+15),c);colors[c+3]=part.emissive?255:0;}
      for(let i=0;i<part.indices.length;i++)allIndices[io+i]=part.indices[i]+vo/16;vo+=part.vertices.byteLength;io+=part.indices.length;}
    parts.length=0;
    const geometry=new THREE.BufferGeometry(),positions=new THREE.InterleavedBuffer(new Float32Array(vertices.buffer),4);
    geometry.setAttribute('position',new THREE.InterleavedBufferAttribute(positions,3,0));
    geometry.setAttribute('lowpolyColor',new THREE.BufferAttribute(colors,4,true));
    const visibleIndices=new Uint32Array(indexOffset),index=new THREE.BufferAttribute(visibleIndices,1).setUsage(THREE.DynamicDrawUsage);
    geometry.setIndex(index);geometry.setDrawRange(0,0);resources.push(geometry);
    const mesh=new THREE.Mesh(geometry,material);mesh.name='FarLowPolySceneMesh';mesh.userData.torusPreBent=true;
    mesh.frustumCulled=false;mesh.matrixAutoUpdate=false;group.add(mesh);scene.scene.add(group);
    stats.triangles=indexOffset/3;stats.bytes=vertices.byteLength+colors.byteLength+visibleIndices.byteLength;stats.buildMs=performance.now()-started;
    function valid(source:Source){
      const entry=source.entry;
      if(entry.geometry!==source.geometry||entry.count!==source.count||entry.invalid||entry.releasing||!entry.page.entries.has(entry)
        ||entry.mesh.material!==entry.mesh.userData.opaqueMaterial||entry.versions.length!==source.versions.length)return false;
      for(let i=0;i<source.versions.length;i++)if(entry.versions[i]!==source.versions[i])return false;
      return true;
    }
    const blank={map:new Float32Array(0),blocks:0,faces:0,back:0,outside:0,covered:0};
    let dirty=true,lastEpoch=-1;
    undo.push(interceptMethod(arena,'visibleBlocks',(original,args)=>{
      const result=original(...args);if(!enabled)return result;
      const source=chosen.get(args[0]);return source&&valid(source)?blank:result;
    }));
    const frustum=new THREE.Frustum(),vp=new THREE.Matrix4(),box=new THREE.Box3(),center=new THREE.Vector3();
    function refresh(){
      if(!enabled)return;
      // Arena's guarded view epoch already accounts for camera motion and mask changes.
      if(!dirty&&lastEpoch===arena.viewEpoch&&!layer.hasPendingWork)return;
      dirty=false;lastEpoch=arena.viewEpoch;const at=performance.now();let count=0,fallback=0;
      vp.multiplyMatrices(scene.camera.projectionMatrix,scene.camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(vp,THREE.WebGPUCoordinateSystem);
      for(const source of sources){
        if(!valid(source)){fallback++;continue;}
        for(const brick of source.bricks){
          box.min.fromArray(brick.bounds);box.max.fromArray(brick.bounds,3);box.getCenter(center);
          // Match the Arena epoch's conservative translation/angular slack.
          box.expandByScalar(18+center.distanceTo(scene.camera.position)*.061);
          if(frustum.intersectsBox(box)){visibleIndices.set(allIndices.subarray(brick.start,brick.start+brick.count),count);count+=brick.count;}
        }
      }
      geometry.setDrawRange(0,count);index.clearUpdateRanges();if(count)index.addUpdateRange(0,count);index.needsUpdate=true;
      stats.visibleTriangles=count/3;stats.fallbackSources=fallback;stats.refreshes++;stats.refreshMs+=performance.now()-at;
    }
    const previousState=new Map<any,boolean>();
    undo.push(interceptMethod(layer,'updateView',(original,args)=>{
      if(!enabled)return original(...args);
      if(enabled&&game.playerPhysics.position.distanceTo(initial)>64)throw new Error('Frozen low-poly trial exceeded 64 m movement guard.');
      // Material/ownership changes invalidate both representations together.
      for(const source of sources){const state=valid(source);if(previousState.get(source)!==state){previousState.set(source,state);dirty=true;arena.visibilityDirty=true;layer.arenaDirty=true;}}
      const result=original(...args);refresh();return result;
    }));
    function set(value:boolean){
      if(closed)throw new Error('Scene trial closed.');enabled=value;group.visible=value;dirty=true;arena.visibilityDirty=true;layer.arenaDirty=true;
      note.textContent=`Far terrain: ${value?`${pixels} px low-poly`:'production packed'} · full-scene experiment`;
    }
    function dispose(){if(closed)return;set(false);closed=true;undo.reverse().forEach(fn=>fn());scene.scene.remove(group);resources.forEach(r=>r.dispose());material.dispose();note.remove();}
    set(false);resume();requestAnimationFrame(game.animate);
    return {set,dispose,stats,initial,group,note,get enabled(){return enabled;}};
  }catch(error){undo.reverse().forEach(fn=>fn());scene.scene.remove(group);resources.forEach(r=>r.dispose());material.dispose();note.remove();resume();requestAnimationFrame(game.animate);throw error;}
}
