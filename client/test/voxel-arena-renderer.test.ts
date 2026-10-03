import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { installVoxelArenaSupport } from '../src/engine/render/VoxelArenaRenderer.ts';

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
