import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { installVoxelArenaSupport } from '../src/engine/render/VoxelArenaRenderer.ts';
import { VoxelTexturePool } from '@entropydrop/space-engine/render/VoxelTexturePool.ts';

test('position invariance is confined to far terrain vertex output', () => {
  const renderer:any={backend:{isWebGPUBackend:true,createNodeBuilder(){return {
    material:{userData:{}},getBuiltins(){return '@builtin( position ) position : vec4<f32>';}};}},
    _objects:{createRenderObject(){}},_geometries:{delete(){}}};
  assert.equal(installVoxelArenaSupport(renderer),true);
  const builder=renderer.backend.createNodeBuilder();
  assert.doesNotMatch(builder.getBuiltins('vertex'),/@invariant/);
  builder.material.userData.voxelArenaPosition=true;
  assert.match(builder.getBuiltins('vertex'),/@invariant @builtin/);
  assert.doesNotMatch(builder.getBuiltins('fragment'),/@invariant/);
});

test('retiring storage drops cached CPU arrays and permits geometry initialization on fallback', () => {
  const geometry=new THREE.BufferGeometry();let retired=0,deleted=0;
  const object:any={object:{userData:{voxelArenaCompatible:true}},geometry,attributes:[new Float32Array(10)],vertexBuffers:[],
    onDispose(){retired++;},dispose(){this.onDispose();}};
  const renderer:any={backend:{isWebGPUBackend:true,createNodeBuilder(){}},
    _objects:{createRenderObject(){return object;}},_geometries:{delete(value:unknown){assert.equal(value,geometry);deleted++;}}};
  assert.equal(installVoxelArenaSupport(renderer),true);renderer._objects.createRenderObject();
  (geometry as any).dispatchEvent({type:'voxelarenaretire'});
  (geometry as any).dispatchEvent({type:'voxelarenaretire'});
  assert.equal(retired,1);assert.equal(deleted,1);assert.equal(object.attributes,null);assert.equal(object.vertexBuffers,null);
});

test('unknown renderer contracts retain the ordinary path', () => {
  assert.equal(installVoxelArenaSupport({}),false);
});

test('baked arrays upload changed layers and restore all live layers after GPU recreation', () => {
  const texture = new THREE.DataArrayTexture(new Uint8Array(256 * 256 * 4 * 4), 256, 256, 4);
  const active = new Set([0, 2]); texture.userData.voxelBakeLayers = active;
  const writes: any[] = [], data = {texture: {}, version: 0}; let ordinary = 0;
  const renderer: any = {backend: {isWebGPUBackend:true, createNodeBuilder(){}, get(){return data;},
    updateTexture(){ordinary++;}, device:{queue:{writeTexture(...args:any[]){writes.push(args);}}}},
    _objects:{createRenderObject(){}}, _geometries:{delete(){}}};
  installVoxelArenaSupport(renderer);
  texture.addLayerUpdate(2); texture.needsUpdate = true;
  renderer.backend.updateTexture(texture, {});
  assert.deepEqual(writes.map(w=>w[0].origin[2]), [0,2]);
  assert.ok(writes.every(w=>w[1].byteLength===256*256*4));
  assert.equal(texture.layerUpdates.size,0);
  writes.length=0; active.add(3);texture.addLayerUpdate(3);texture.needsUpdate=true;
  renderer.backend.updateTexture(texture, {});
  assert.deepEqual(writes.map(w=>w[0].origin[2]), [3]);assert.equal(data.version,texture.version);
  writes.length=0;active.delete(0);data.texture={};
  renderer.backend.updateTexture(texture, {});
  assert.deepEqual(writes.map(w=>w[0].origin[2]), [2,3]);
  renderer.backend.updateTexture(new THREE.Texture(),{});assert.equal(ordinary,1);texture.dispose();
});

test('shared atlas updates upload only changed rectangles and restore complete live layers', () => {
  const pool = new VoxelTexturePool(8,false), writes:any[] = [], data={texture:{},version:0};
  const renderer:any={backend:{isWebGPUBackend:true,createNodeBuilder(){},get(){return data;},updateTexture(){},
    device:{queue:{writeTexture(...args:any[]){writes.push(args);}}}},_objects:{createRenderObject(){}},_geometries:{delete(){}}};
  installVoxelArenaSupport(renderer);
  const a=pool.acquire(new Uint8Array(64*64*4).fill(31),64)!;
  renderer.backend.updateTexture(pool.texture,{});assert.equal(writes[0][3].width,256);writes.length=0;
  const b=pool.acquire(new Uint8Array(64*64*4).fill(79),64)!;
  renderer.backend.updateTexture(pool.texture,{});
  assert.equal(writes.length,1);assert.deepEqual(writes[0][0].origin,[b.x,b.y,b.layer-1]);
  assert.deepEqual(writes[0][3],{width:64,height:64,depthOrArrayLayers:1});assert.equal(writes[0][1][0],79);
  assert.equal(writes[0][2].bytesPerRow,1024);assert.equal(pool.stats.uploadedBytes,256*256*4+64*64*4);
  writes.length=0;data.texture={};renderer.backend.updateTexture(pool.texture,{});
  assert.equal(writes.length,1);assert.equal(writes[0][3].width,256);
  const restored=writes[0][1];assert.equal(restored[(a.y*256+a.x)*4],31);assert.equal(restored[(b.y*256+b.x)*4],79);
  a.release();b.release();pool.dispose();
});
