import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Contraption } from '../src/contraption/Contraption.ts';
import { ContraptionPhysics } from '../src/physics/ContraptionPhysics.ts';

function fixture(options: any = {}) {
  const entity = new Contraption('probe', [{localX:0,localY:0,localZ:0,block:1,entityId:'root'}],
    new THREE.Vector3(4,10,0),new THREE.Scene(),{rootComponentId:'root',useGravity:false});
  let samples=0;
  const original=entity.getCollisionSamplePoints.bind(entity);
  entity.getCollisionSamplePoints=(...args)=>{samples++;return original(...args);};
  const world:any={getBlock:()=>0,raycast:()=>({hit:false}),raycastMicro:()=>({hit:false}),
    getMicroCollisionBoxesInAABB:()=>[],...options};
  const physics=new ContraptionPhysics(world);
  const body=entity.getRigidBody('root')!;
  const previous={position:body.position.clone().add(new THREE.Vector3(-4,0,0)),quaternion:body.quaternion.clone()};
  return {entity,physics,body,previous,samples:()=>samples};
}

test('fast movement through proven empty terrain skips point CCD',()=>{
  const f=fixture(); f.physics.resolveTerrainCollisionBody(f.entity,f.body,1/60,f.previous);
  assert.equal(f.samples(),0);
});
test('a standard obstacle between clear endpoints retains point CCD',()=>{
  const f=fixture({getBlock:(x:number,y:number,z:number)=>x===2&&y===10&&z===0?1:0});
  f.physics.resolveTerrainCollisionBody(f.entity,f.body,1/60,f.previous);
  assert.ok(f.samples()>0);
});
test('a thin micro obstacle between clear endpoints retains point CCD',()=>{
  const obstacle={minX:2,maxX:2.125,minY:10,maxY:11,minZ:0,maxZ:1};
  const f=fixture({getMicroCollisionBoxesInAABB:(b:any)=>b.minX<obstacle.maxX&&b.maxX>obstacle.minX?[obstacle]:[]});
  f.physics.resolveTerrainCollisionBody(f.entity,f.body,1/60,f.previous);
  assert.ok(f.samples()>0);
});
test('point-only micro hosts cannot certify an empty swept envelope',()=>{
  const f=fixture({getMicroCollisionBoxesInAABB:undefined,getMicroCollisionBlock:()=>null});
  f.physics.resolveTerrainCollisionBody(f.entity,f.body,1/60,f.previous);
  assert.ok(f.samples()>0);
});
test('rotation allowance retains an obstacle outside the final box',()=>{
  const f=fixture({getBlock:(x:number,y:number,z:number)=>x===3&&y===10&&z===0?1:0});
  f.previous.position.copy(f.body.position);
  f.previous.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2);
  f.physics.resolveTerrainCollisionBody(f.entity,f.body,1/60,f.previous);
  assert.ok(f.samples()>0);
});

test('raycast-only micro hosts retain CCD even without a point occupancy API',()=>{
  const f=fixture({getMicroCollisionBoxesInAABB:undefined});
  f.physics.resolveTerrainCollisionBody(f.entity,f.body,1/60,f.previous);
  assert.ok(f.samples()>0);
});
