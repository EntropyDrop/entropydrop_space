/** Development-only controlled terrain projection experiment. */
import * as THREE from 'three/webgpu';
import { cameraViewMatrix, modelWorldMatrix, vec4 } from 'three/tsl';
import { TerrainGenerator } from '@entropydrop/space-engine/worldgen/TerrainGenerator.ts';
import { Chunk } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { LowPolyMesher } from '@entropydrop/space-engine/mesher/LowPolyMesher.ts';
import { MicroVoxelLayer } from '@entropydrop/space-engine/voxel/MicroVoxelLayer.ts';
import { getTerrainKernels, setTerrainKernelMode } from '@entropydrop/space-engine/wasm/TerrainKernels.ts';
import { createVoxelSurfaceMaterial } from '@entropydrop/space-engine/render/DistantVoxelLayer.ts';
import { VoxelFaceArena, type ArenaInputs, type VoxelFaceMesh } from '@entropydrop/space-engine/render/VoxelFaceArena.ts';
import { voxelFaceVisibility } from '@entropydrop/space-engine/render/VoxelFaceVisibility.ts';
import { cloneVoxelMaterial } from '@entropydrop/space-engine/render/VoxelTranslucency.ts';
import { bendPoint, bendDirection, applyCameraBend, computeBentBoundsSphere, hookSceneMaterials,
  setTorusViewCorrection, projectBentSphereForView } from '@entropydrop/space-engine/torus/TorusWorld.ts';
import { LIGHTING_PRESETS } from '../engine/render/LightingQuality.ts';
import { interceptMethod, guardTimestampWrites } from './FrameDiagnostics.ts';
import { gpuTimestampSpan } from './GpuTimestampSpan.ts';
import { summarize } from './MaintenanceBenchmark.ts';

type Projection = 'flat' | 'torus';
type Culling = 'fixed-submission' | 'frustum';
type Item = { object: THREE.Object3D; flat: THREE.Sphere; torus: THREE.Sphere };
type Pass = { descriptor: any; commands: { method: string; args: any[] }[] };
const $ = (id: string) => document.getElementById(id)!;
const status = (text: string) => { $('status').textContent = text; };
const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const flatPoint = (x: number,y: number,z: number,out=new THREE.Vector3()) => out.set(x,y,z);
function exhaust<T>(iterator: Generator<void,T>): T { let value=iterator.next(); while(!value.done)value=iterator.next();return value.value; }
const WIDTH = 2560, HEIGHT = 1440, REPLAY_FRAMES = 8, QUARTETS = 24;
const worlds = [['Nature', 1, 20260827], ['Copper Metropolis', 2, 20260922], ['Aether Archipelago', 3, 42]] as const;
const poses = [
  { name: 'ground-near', y: 18, yaw: Math.PI / 2, pitch: -.65 },
  { name: 'ground-forward', y: 18, yaw: Math.PI / 2, pitch: .05 },
  { name: 'elevated-tube', y: 160, yaw: Math.PI, pitch: -.35 },
];
const results: any = { revision: 'surface-camera-block-culling-aoi-clipped', date: new Date().toISOString(), userAgent: navigator.userAgent, three: THREE.REVISION,
  scope: 'Terrain render only. No simulation, entities, networking, HUD, picking, shadows, postprocessing or streaming. Fixed mesh topology in both projections; no flat-only greedy remeshing. Not full-world game FPS.',
  settings: { width: WIDTH, height: HEIGHT, samples: 4, lighting: 'medium', exposure: 1.15, footprint: [7680, 512, 8704, 1536],
    aoiChunks: [504,60,520,68], nearMicroSize: .125, coarseCulling: 'tight face AABB per 64 m brick', blockCulling: 'production 16-face sphere and normal cone in matching projection', cameraHeight: 'local surface + 1.7 m; elevated max(160, surface+60)', outsideAoiCellSize: 1, fov: 75, far: 2000,
    replayFrames: REPLAY_FRAMES, measuredQuartets: QUARTETS, warmupQuartets: 4 }, fixtures: [], rows: [], errors: [] };
let renderer: THREE.WebGPURenderer, device: any, target: THREE.RenderTarget;
let active: Awaited<ReturnType<typeof fixture>> | undefined;
const materialPairs = new Map<THREE.NodeMaterial, [THREE.NodeMaterial, THREE.NodeMaterial]>();
const choices = new Map<THREE.Object3D, [THREE.Material | THREE.Material[], THREE.Material | THREE.Material[]]>();
function pair(source: THREE.NodeMaterial): [THREE.NodeMaterial, THREE.NodeMaterial] {
  const existing = materialPairs.get(source); if (existing) return existing;
  if (source.userData.torusNode) throw new Error('Expected undeformed source material.');
  const flat = cloneVoxelMaterial(source), torus = cloneVoxelMaterial(source);
  flat.userData = { ...source.userData }; torus.userData = { ...source.userData };
  if (source.userData.flatNormalNode && source.lights && !('flatShading' in source && source.flatShading)) {
    const n = source.userData.flatNormalNode;
    flat.normalNode = cameraViewMatrix.mul(vec4(source.userData.voxelIntegerCoordinates ? n : modelWorldMatrix.mul(vec4(n,0)).xyz, 0)).xyz.normalize();
  }
  const holder = new THREE.Mesh(new THREE.BufferGeometry(), torus);
  hookSceneMaterials(holder); holder.geometry.dispose();
  const value: [THREE.NodeMaterial, THREE.NodeMaterial] = [flat, torus]; materialPairs.set(source, value); return value;
}
function register(object: THREE.Object3D) {
  object.traverse((node: any) => {
    node.frustumCulled = false;
    if (!node.material) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const pairs: [THREE.NodeMaterial, THREE.NodeMaterial][] = materials.map((m: THREE.NodeMaterial) => pair(m));
    choices.set(node, [Array.isArray(node.material) ? pairs.map(p => p[0]) : pairs[0][0],
      Array.isArray(node.material) ? pairs.map(p => p[1]) : pairs[0][1]]);
  });
}
function quadGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0,1,0,0,1,1,0,0,1,0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0,1,0,0,1,0,0,1,0,0,1,0], 3));
  g.setIndex([0,1,2,0,2,3]); return g;
}
function bounds(object: THREE.Object3D, box: THREE.Box3): Item {
  return { object, flat: box.getBoundingSphere(new THREE.Sphere()), torus: computeBentBoundsSphere({
    minX: box.min.x, minY: box.min.y, minZ: box.min.z, maxX: box.max.x, maxY: box.max.y, maxZ: box.max.z }) };
}
const inAoi = (x: number, z: number) => x >= 504 && x <= 520 && z >= 60 && z <= 68;
async function fixture(name: string, version: number, seed: number) {
  status(`Generating ${name}: fixed 1 m far surface and detailed AOI`);
  materialPairs.clear(); choices.clear();
  const generator = new TerrainGenerator(seed, version), column = getTerrainKernels()!.createVoxelSurfaceColumn();
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#74b9ff');
  const group = new THREE.BundleGroup(); scene.add(group);
  const mask = new THREE.DataTexture(new Uint8Array(4), 1, 1); mask.needsUpdate = true;
  const make = (inputs?: ArenaInputs) => {
    const material = createVoxelSurfaceMaterial(mask, new THREE.Vector2(0,1), new THREE.Vector3(), { value: true }, true, inputs);
    const mesh = new THREE.Mesh(quadGeometry(), material); mesh.frustumCulled = false;
    mesh.userData.opaqueMaterial = material; register(mesh); return mesh;
  };
  const arena = new VoxelFaceArena(group, make), items: Item[] = [], sources: VoxelFaceMesh[] = [];
  const chunks = new Map<string, Chunk>();
  const world: any = { terrainGen: generator, worldToChunkCoords: (x: number,z: number) => ({ cx: Math.floor(x/16),cz: Math.floor(z/16) }),
    getChunk: (x: number,z: number) => chunks.get(`${x},${z}`), markChunkDirty() {} };
  let farFaces = 0, checksum = 2166136261;
  const linear = Uint8Array.from({length:256}, (_,n) => Math.round(255*(n/255 <= .04045 ? n/255/12.92 : ((n/255+.055)/1.055)**2.4)));
  for (let bx = 120; bx < 136; bx++) for (let bz = 8; bz < 24; bz++) {
    column.reset();
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
      const chunk = new Chunk(bx*4+x, bz*4+z, world); generator.generateChunk(chunk, true);
      // Carve AOI ownership before greedy meshing so no merged far face can cross its boundary.
      if(!inAoi(chunk.cx,chunk.cz)) column.addChunk(chunk,x,z);
      if (chunk.cx >= 503 && chunk.cx <= 521 && chunk.cz >= 59 && chunk.cz <= 69) chunks.set(`${chunk.cx},${chunk.cz}`, chunk);
    }
    for (let y = 0; y < 4; y++) {
      const records = column.meshBrick(y,0,0)?.[0]; if (!records) continue;
      const data = new DataView(records.buffer, records.byteOffset, records.byteLength), keep: number[] = [];
      for (let at = 0; at < records.length; at += 16) {
        const d=records[at+10],axis=d>>1,sign=d&1?1:-1;
        const x=bx*64+data.getUint16(at,true)/8+(axis===0?-sign*.001:0);
        const z=bz*64+data.getUint16(at+4,true)/8+(axis===2?-sign*.001:0);
        const u=data.getUint16(at+6,true)/8,v=data.getUint16(at+8,true)/8;
        const maxX=x+(axis===0?0:axis===1?v:u),maxZ=z+(axis===2?0:axis===0?v:u);
        const overlapX=axis===0?x>=8064&&x<8336:Math.min(maxX,8336)>Math.max(x,8064);
        const overlapZ=axis===2?z>=960&&z<1104:Math.min(maxZ,1104)>Math.max(z,960);
        if(overlapX&&overlapZ)throw new Error('Far face overlaps detailed AOI.');
        keep.push(at);
      }
      if (!keep.length) continue;
      const mesh = make(), n = keep.length, offset = new Float32Array(n*3), span = new Float32Array(n*2),
        direction = new Float32Array(n), emission = new Float32Array(n), color = new Uint8Array(n*4);
      keep.forEach((at,i) => {
        for (let c=0;c<3;c++) offset[i*3+c] = data.getUint16(at+c*2,true);
        span[i*2] = data.getUint16(at+6,true); span[i*2+1] = data.getUint16(at+8,true);
        direction[i] = records[at+10]; emission[i] = records[at+11];
        for (let c=0;c<3;c++) color[i*4+c] = emission[i] ? records[at+12+c] : linear[records[at+12+c]];
        color[i*4+3]=255;
        for(let c=0;c<16;c++) checksum = Math.imul(checksum ^ records[at+c], 16777619) >>> 0;
      });
      for(const [key,array,size,normalized] of [['voxelOffset',offset,3,false],['voxelSpan',span,2,false],['voxelDirection',direction,1,false],
        ['voxelEmission',emission,1,false],['color',color,4,true]] as const) mesh.geometry.setAttribute(key,new THREE.InstancedBufferAttribute(array,size,normalized));
      const faces={count:n,offset:Uint16Array.from(offset),span:Uint16Array.from(span),direction:Uint8Array.from(direction)};
      const flatVisibility=exhaust(voxelFaceVisibility(faces,bx*64,bz*64,flatPoint));
      const torusVisibility=exhaust(voxelFaceVisibility(faces,bx*64,bz*64));
      mesh.userData.projectionVisibility=[flatVisibility,torusVisibility];
      mesh.geometry.instanceCount=n; Object.assign(mesh.userData,{voxelOrigin:new THREE.Vector3(bx*64,0,bz*64),voxelArenaCompatible:true,
        voxelTile:Math.floor(bx/2)*16+Math.floor(bz/2)});
      group.add(mesh); sources.push(mesh); farFaces+=n;
      const box=new THREE.Box3();
      for(let i=0;i<n;i++) {
        const x=bx*64+offset[i*3]/8,y=offset[i*3+1]/8,z=bz*64+offset[i*3+2]/8,u=span[i*2]/8,v=span[i*2+1]/8,axis=direction[i]>>1;
        box.expandByPoint(new THREE.Vector3(x,y,z));
        box.expandByPoint(new THREE.Vector3(x+(axis===0?0:axis===1?v:u),y+(axis===1?0:axis===0?u:v),z+(axis===2?0:axis===0?v:u)));
      }
      items.push(bounds(mesh,box));
    }
    if (bz % 4 === 3) { status(`Generating ${name}: ${(bx-120)*16+bz-7}/256 columns`); await nextFrame(); }
  }
  const mesher = new LowPolyMesher(), micro = new MicroVoxelLayer(); let nearTriangles=0;
  for (const chunk of chunks.values()) if(inAoi(chunk.cx,chunk.cz)) {
    const object=mesher.buildChunkMesh(chunk); scene.add(object); register(object);
    object.updateMatrixWorld(true); items.push(bounds(object,new THREE.Box3().setFromObject(object)));
    object.traverse((n:any)=> { if(n.geometry?.index) nearTriangles+=n.geometry.index.count/3; });
    micro.setPackedTerrainCells(chunk.cx*128,chunk.cz*128,chunk.terrainDetails,(x,y,z)=>!chunk.blocks[Chunk.getIndex(x>>3,y>>3,z>>3)]);
  }
  const microDeadline=performance.now()+120000;
  do { micro.updateMesh(16,null,null,10); await nextFrame(); if(performance.now()>microDeadline)throw new Error('Micro publication timeout.'); } while(micro.dirty);
  for(const mesh of micro.renderMeshes.values()) {
    mesh.removeFromParent(); scene.add(mesh); register(mesh); mesh.updateMatrixWorld(true);
    items.push(bounds(mesh,new THREE.Box3().setFromObject(mesh))); nearTriangles+=(mesh.geometry.index?.count??0)/3;
  }
  if(micro.dirty)throw new Error('Unsettled micro meshes.');
  do { arena.restoreSources(); arena.sync(20,1024*1024); await nextFrame(); } while(arena.hasPendingWork);
  if(arena.stats.residentFaces!==farFaces)throw new Error('Far publication mismatch.');
  const preset=LIGHTING_PRESETS.medium;
  const hemi=new THREE.HemisphereLight(preset.hemisphereSkyColor,preset.hemisphereGroundColor,preset.hemisphereIntensity);
  const sun=new THREE.DirectionalLight(preset.sunColor,preset.sunIntensity); scene.add(hemi,sun,sun.target);
  const camera=new THREE.PerspectiveCamera(75,WIDTH/HEIGHT,.1,2000), frustum=new THREE.Frustum(), matrix=new THREE.Matrix4(), projected=new THREE.Sphere();
  let surfaceY=0; const centerChunk=chunks.get('512,64')!;for(let y=0;y<256;y++)if(centerChunk.getLocalBlock(0,y,0))surfaceY=y+1;
  const stats={name,version,seed,surfaceY,columns:256,nearChunks:153,farFaces,nearTriangles,totalTriangles:farFaces*2+nearTriangles,
    farRecordChecksum:checksum,arena:{...arena.stats}}; results.fixtures.push(stats);
  const sourceSet = new Set<THREE.Object3D>(sources);
  const prepare=(projection:Projection,culling:Culling,pose:typeof poses[number])=>{
    const time=performance.now();
    camera.position.set(8192,pose.y,1024); camera.rotation.set(pose.pitch,pose.yaw,0,'YXZ');
    const up=new THREE.Vector3(0,1,0), light=new THREE.Vector3(.5,Math.sqrt(3)/2,.25).normalize();
    sun.target.position.copy(camera.position);
    if(projection==='torus') {
      setTorusViewCorrection(camera.position); bendPoint(8192,pose.y,1024,sun.target.position);
      bendDirection(8192,pose.y,1024,up,up); bendDirection(8192,pose.y,1024,light,light); applyCameraBend(camera);
    } else { setTorusViewCorrection(null); camera.updateMatrixWorld(true); }
    hemi.position.copy(up); sun.position.copy(sun.target.position).addScaledVector(light,80); sun.target.updateMatrixWorld(true);
    frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),THREE.WebGPUCoordinateSystem);
    arena.restoreSources();
    for(const item of items) item.object.visible=culling==='fixed-submission'||frustum.intersectsSphere(projection==='flat'?item.flat:projectBentSphereForView(item.torus,projected));
    for(const source of sources) source.geometry.userData.voxelVisibility=source.userData.projectionVisibility[projection==='flat'?0:1];
    arena.setView(camera.position,frustum,mask,culling==='frustum');
    // Source material identity stays fixed for Arena eligibility. Only drawing materials change.
    arena.sync(0,0,true);
    for(const [object,pair] of choices) if(!sourceSet.has(object)) {
      const mesh=object as THREE.Mesh, selected=pair[projection==='flat'?0:1];
      if(mesh.material!==selected) { mesh.material=selected; group.needsUpdate=true; }
    }
    for(const page of arena.pages)for(const run of page.runs) {
      const variants=choices.get(page.mesh)!, selected=variants[projection==='flat'?0:1] as THREE.MeshStandardNodeMaterial;
      if(run.material!==selected) { run.material=selected; group.needsUpdate=true; }
    }
    return performance.now()-time;
  };
  return {scene,camera,arena,prepare,stats,dispose(){
    (micro as any).meshWorker?.terminate();
    arena.dispose(false); const geometries=new Set<THREE.BufferGeometry>(); scene.traverse((n:any)=>{if(n.geometry)geometries.add(n.geometry);});
    geometries.forEach(g=>g.dispose()); for(const [source,pair]of materialPairs){ source.dispose(); pair.forEach(m=>m.dispose()); }
    mask.dispose(); choices.clear(); materialPairs.clear();
  }};
}
function render() { renderer.info.reset(); renderer.render(active!.scene,active!.camera); }
async function capture():Promise<Pass[]> {
  const passes:Pass[]=[], undo:(()=>void)[]=[];
  undo.push(interceptMethod(device,'createCommandEncoder',(original,args)=>{
    const encoder=original(...args);
    interceptMethod(encoder,'beginRenderPass',(begin,args)=>{
      const source=args[0]; if(source.occlusionQuerySet)throw new Error('Unexpected occlusion pass.');
      const saved:Pass={descriptor:{...source,timestampWrites:undefined,colorAttachments:source.colorAttachments.map((a:any)=>a&&({...a})),
        depthStencilAttachment:source.depthStencilAttachment&&{...source.depthStencilAttachment}},commands:[]}; passes.push(saved);
      const pass=begin(...args);
      for(const method of ['setPipeline','setBindGroup','setVertexBuffer','setIndexBuffer','setViewport','setScissorRect','setBlendConstant','setStencilReference',
        'draw','drawIndexed','drawIndirect','drawIndexedIndirect','executeBundles']) interceptMethod(pass,method,(call,args)=>{
          saved.commands.push({method,args:args.map(v=>Array.isArray(v)?[...v]:ArrayBuffer.isView(v)?(v as any).slice():v)}); return call(...args);
        });
      return pass;
    }); return encoder;
  }));
  try { render(); await device.queue.onSubmittedWorkDone(); } finally { undo.reverse().forEach(f=>f()); }
  if(passes.length!==1)throw new Error(`Expected one terrain pass, got ${passes.length}`);
  return passes;
}
function encode(encoder:any,passes:Pass[],query?:any,first=0,scissor=false) {
  passes.forEach((saved,i)=>{
    const pass=encoder.beginRenderPass({...saved.descriptor,timestampWrites:query?{querySet:query,beginningOfPassWriteIndex:first+i*2,endOfPassWriteIndex:first+i*2+1}:undefined});
    for(const command of saved.commands) {
      if(scissor&&command.method==='setScissorRect')continue;
      if(scissor&&(command.method.startsWith('draw')||command.method==='executeBundles'))pass.setScissorRect(0,0,1,1);
      pass[command.method](...command.args);
    } pass.end();
  });
}
async function verifyReplay(passes:Pass[]) {
  const before=await renderer.readRenderTargetPixelsAsync(target,0,0,WIDTH,HEIGHT);
  const encoder=device.createCommandEncoder(); encode(encoder,passes); device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
  const after=await renderer.readRenderTargetPixelsAsync(target,0,0,WIDTH,HEIGHT);
  let different=0;for(let i=0;i<before.length;i++)if(before[i]!==after[i])different++;
  if(different)throw new Error(`Native replay pixel mismatch: ${different} channels.`);
  return {changedChannels:different};
}
async function measure(pose:typeof poses[number],culling:Culling,control=false,scissor=false) {
  const usage=(globalThis as any).GPUBufferUsage;
  const query=device.createQuerySet({type:'timestamp',count:REPLAY_FRAMES*2});
  const resolve=device.createBuffer({size:REPLAY_FRAMES*16,usage:usage.QUERY_RESOLVE|usage.COPY_SRC});
  const read=device.createBuffer({size:REPLAY_FRAMES*16,usage:usage.MAP_READ|usage.COPY_DST});
  const samples:any[]=[], audits:any[]=[]; let pipelines=0;
  const undo=interceptMethod(renderer.backend,'createRenderPipeline',(original,args)=>{pipelines++;return original(...args);});
  device.pushErrorScope('validation');let scoped=true;
  try {
    for(let quartet=-4;quartet<(control?8:QUARTETS);quartet++) {
      const order=quartet%2===0?['flat','torus','torus','flat']:['torus','flat','flat','torus'];
      for(let slot=0;slot<4;slot++) {
        if(document.visibilityState!=='visible')throw new Error('Benchmark tab hidden.');
        const role=order[slot] as Projection,projection:Projection=control?'flat':role;
        active!.prepare(projection,culling,pose);
        for(let i=0;i<3;i++)render(); await device.queue.onSubmittedWorkDone();
        const beforePipelines=pipelines,passes=await capture();
        if(quartet===-4&&slot<2)audits.push({role,...await verifyReplay(passes)});
        const direct=passes.flatMap(p=>p.commands).filter(c=>c.method==='draw'||c.method==='drawIndexed');
        const drawCalls=direct.length+active!.arena.stats.draws,triangles=direct.reduce((sum,c)=>sum+c.args[0]*(c.args[1]??1)/3,0)+active!.arena.stats.drawnFaces*2;
        const encoder=device.createCommandEncoder();
        for(let frame=0;frame<REPLAY_FRAMES;frame++)encode(encoder,passes,query,frame*2,scissor);
        encoder.resolveQuerySet(query,0,REPLAY_FRAMES*2,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,REPLAY_FRAMES*16);
        device.queue.submit([encoder.finish()]);await read.mapAsync((globalThis as any).GPUMapMode.READ);
        const times=new BigUint64Array(read.getMappedRange()).slice();read.unmap();
        const span=gpuTimestampSpan(times)!;
        if(quartet>=0)samples.push({quartet,slot,role,projection,gpuMs:span.spanMs/REPLAY_FRAMES,rawNanoseconds:[...times].map(String),drawCalls,triangles,
          newPipelines:pipelines-beforePipelines,residentFaces:active!.arena.stats.residentFaces,visibleFaces:active!.arena.stats.visibleFaces});
      }
      if(quartet%4===3)await nextFrame();
    }
    const error=await device.popErrorScope();scoped=false;if(error)throw new Error(error.message);
    const flat=samples.filter(s=>s.role==='flat'),torus=samples.filter(s=>s.role==='torus');
    const paired=Array.from({length:control?8:QUARTETS},(_,q)=>{
      const rows=samples.filter(s=>s.quartet===q),avg=(role:string)=>rows.filter(s=>s.role===role).reduce((a,s)=>a+s.gpuMs,0)/2;
      return (avg('torus')/avg('flat')-1)*100;
    });
    return {control,culling,scissor,pose,flat:summarize(flat.map(s=>s.gpuMs)),torus:summarize(torus.map(s=>s.gpuMs)),
      pairedPercent:summarize(paired),samples,audits};
  } finally { if(scoped)await device.popErrorScope();undo();query.destroy();resolve.destroy();read.destroy(); }
}
async function measureCpu(pose:typeof poses[number],culling:Culling) {
  const samples:any[]=[];
  for(let quartet=-2;quartet<8;quartet++)for(const projection of (quartet%2===0?['flat','torus','torus','flat']:['torus','flat','flat','torus'])as Projection[]) {
    active!.prepare(projection,culling,pose);render();await device.queue.onSubmittedWorkDone();
    const preparation:number[]=[],submit:number[]=[];
    for(let frame=0;frame<30;frame++) {
      // Equal deterministic small turn exercises bounds and rendering, with fixed residency.
      const moving={...pose,yaw:pose.yaw+.2*Math.sin(frame*Math.PI/15)};
      preparation.push(active!.prepare(projection,culling,moving));const start=performance.now();render();submit.push(performance.now()-start);
    }
    await device.queue.onSubmittedWorkDone();if(quartet>=0)samples.push({projection,preparation,submit});await nextFrame();
  }
  return Object.fromEntries((['flat','torus']as const).map(p=>[p,{prepare:summarize(samples.filter(s=>s.projection===p).flatMap(s=>s.preparation)),
    render:summarize(samples.filter(s=>s.projection===p).flatMap(s=>s.submit))}]));
}
async function screenshot(projection:Projection,pose:typeof poses[number]) {
  active!.prepare(projection,'frustum',pose);renderer.setRenderTarget(null);render();await device.queue.onSubmittedWorkDone();
  const url=renderer.domElement.toDataURL('image/png'),image=document.createElement('img');image.src=url;image.alt=`${active!.stats.name} ${pose.name} ${projection}`;
  $('captures').append(image);renderer.setRenderTarget(target);return {projection,pose:pose.name,url};
}
function publish() {
  $('rows').replaceChildren(...results.rows.map((r:any)=>{
    const tr=document.createElement('tr');for(const value of [`${r.world} / ${r.pose.name} / ${r.culling}${r.scissor?' / 1 px':''}`,r.flat.mean.toFixed(3),r.torus.mean.toFixed(3),
      `${((r.torus.mean/r.flat.mean-1)*100).toFixed(1)}%`,`${r.controlResult.pairedPercent.mean.toFixed(1)}%`]){const td=document.createElement('td');td.textContent=value;tr.append(td);}return tr;
  }));
  $('results').textContent=JSON.stringify({...results,captures:results.captures?.map((c:any)=>({...c,url:'PNG retained separately'}))},null,2);
  ($('save')as HTMLButtonElement).disabled=false;
}
async function run() {
  ($('run')as HTMLButtonElement).disabled=true;
  try {
    if(!import.meta.env.DEV)throw new Error('Development only.');
    setTerrainKernelMode('wasm');
    renderer=new THREE.WebGPURenderer({antialias:true});await renderer.init();
    if(!renderer.hasFeature('timestamp-query'))throw new Error('Native GPU timestamps unavailable.');
    renderer.info.autoReset=false;renderer.setPixelRatio(1);renderer.setSize(WIDTH,HEIGHT);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
    (renderer.backend as any).trackTimestamp=false;guardTimestampWrites(renderer.backend);
    $('view').append(renderer.domElement);device=(renderer.backend as any).device;
    const info=device.adapterInfo;results.adapter=info?{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description}:null;
    target=new THREE.RenderTarget(WIDTH,HEIGHT,{samples:4,type:THREE.UnsignedByteType});renderer.setRenderTarget(target);
    for(const [name,version,seed]of worlds) {
      active=await fixture(name,version,seed);
      const scenePoses=poses.map(p=>({...p,y:p.y===18?active!.stats.surfaceY+1.7:Math.max(160,active!.stats.surfaceY+60)}));
      results.captures??=[];for(const pose of [scenePoses[1],scenePoses[2]])for(const projection of ['flat','torus']as const)
        results.captures.push({world:name,...await screenshot(projection,pose)});
      for(const pose of scenePoses)for(const culling of ['fixed-submission','frustum']as const) {
        status(`${name} / ${pose.name} / ${culling}: warming and A/A control`);
        const controlResult=await measure(pose,culling,true);
        status(`${name} / ${pose.name} / ${culling}: paired GPU measurement`);
        const row=await measure(pose,culling);
        status(`${name} / ${pose.name} / ${culling}: CPU render measurement`);
        const cpu=await measureCpu(pose,culling);
        results.rows.push({world:name,...row,cpu,controlResult});publish();
      }
      status(`${name}: one-pixel vertex diagnostic`);
      const controlResult=await measure(scenePoses[1],'fixed-submission',true,true);
      results.rows.push({world:name,...await measure(scenePoses[1],'fixed-submission',false,true),controlResult});publish();
      active.dispose();active=undefined;await device.queue.onSubmittedWorkDone();
    }
    results.completed=true;status('Complete. Results are available for download.');publish();
  } catch(error) {results.errors.push(String(error));status(`Failed: ${error}`);publish();console.error(error);}
}
$('run').addEventListener('click',()=>void run());
$('save').addEventListener('click',()=>{
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(results)],{type:'application/json'}));a.download='torus-flat-results.json';a.click();URL.revokeObjectURL(a.href);
});
(globalThis as any).projectionBenchmark={results,run};
