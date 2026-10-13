import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssemblyScriptRuntimeService } from '../../engine/src/scripting/AssemblyScriptRuntimeService.ts';
import { createTank } from '../tools/nature-tank/model.ts';
import { Quaternion, Vector3 } from 'three';
import { trackPath } from '../tools/nature-tank/tracks.ts';
const model=createTank();
const stepGround=(p:number[])=>p[2]>=634&&p[2]<637?26:25;
function stepWall(origin:number[],direction:number[],maxDistance:number) {
  if(origin[1]<25||origin[1]>=26||Math.abs(direction[2])<.001) return null;
  const edge=direction[2]>0?634:637;
  const distance=(edge-origin[2])/direction[2];
  return distance>=0&&distance<=maxDistance
    ?{distance,position:[origin[0],25,edge],normal:[0,0,-Math.sign(direction[2])]}:null;
}

async function fixture(t: test.TestContext, options:any={}) {
  const root=model.root;
  const service=createAssemblyScriptRuntimeService();
  const send=(m:any)=>service.handle({entityRuntimeId:'tank-test',...m});
  const compiled=await send({type:'set-script',nodeId:'hull',code:root.script});
  assert.equal(compiled.ok,true,compiled.error);
  // These assertions test vehicle behavior, not host scheduling or GC pauses.
  // Real deadlines are covered by the runtime sandbox suite and browser run.
  t.mock.method(performance,'now',()=>0);
  let rays=0;
  const position=options.position||[6491,27.92,622.875],quaternion=options.quaternion||[0,0,0,1];
  const tick=(extra:any={})=>{
    rays=0;
    const result=send({type:'tick',hostApi:{worldRaycast:(origin:number[],direction:number[],maxDistance:number)=>{
      rays++;
      if(Math.abs(direction[1])<.01) return options.wall?.(origin,direction,maxDistance)??null;
      const ground=options.ground?.(origin)??25;
      return {kind:'world',voxelKind:'standard',position:[Math.floor(origin[0]),ground-1,Math.floor(origin[2])],
        distance:origin[1]-ground,normal:[0,1,0],block:1};
    }},snapshot:{rootComponentId:'hull',entityId:'tank',scriptOrder:['hull'],tick:20,time:1,deltaTime:.05,
      position,velocity:[0,0,0],angularVelocity:[0,0,0],rotation:[0,0,0],
      gravity:[0,-18,0],mass:3500,states:options.states||{},driver:null,input:{down:[],pressed:[],released:[]},
      components:[{id:'hull',parentId:null,children:root.children.map(c=>c.id),pivot:root.pivot,
        worldPosition:position,worldRotation:quaternion,body:root.body,decorations:root.decorations},
        ...root.children.map(c=>({id:c.id,parentId:'hull',children:[],pivot:c.pivot,body:c.body}))],...extra}});
    assert.equal(result.ok,true,result.error);
    assert.deepEqual(result.errors,[]);
    assert.ok(rays<=64,`ray quota exceeded: ${rays}`);
    assert.ok(result.commands.length<=256);
    return result;
  };
  return {tick,root};
}

test('tank uses the hit surface rather than the voxel origin; wheels and lower belt stay above the floor',async t=>{
  const f=await fixture(t),r=f.tick();
  assert.equal(r.states.hull.groundY,25);
  const wheels=r.commands.filter((c:any)=>c.path==='setLocalPosition');
  assert.equal(wheels.length,8);
  for(const c of wheels) assert.ok(27.92+c.args[0][1]-.875>=25.15,'wheel must sit above the lower tread, not inside the floor');
  const shoes=r.commands.filter((c:any)=>c.path==='decorations.upsert');
  assert.equal(shoes.length,64,'both complete tread loops are animated');
  for(const c of shoes){const y=27.92+c.args[1].position[1]-f.root.pivot![1];assert.ok(y-.081>=24.999,'track must stay above the floor');}
});

test('pitched suspension probes follow the wheel center at a one-metre ledge',async t=>{
  const position=[6491,28.1447103157,640.2613086086];
  const quaternion=[.0737220502,0,0,.9972788273];
  const f=await fixture(t,{position,quaternion,ground:stepGround,wall:stepWall,states:{hull:{length_0:.466,length_4:.466}}});
  const result=f.tick();
  for(const c of result.commands.filter((c:any)=>c.path==='setLocalPosition')){
    const center=new Vector3(...c.args[0]).applyQuaternion(new Quaternion(...quaternion)).add(new Vector3(...position));
    assert.ok(center.y-.875>=stepGround(center.toArray())+.15,'the wheel center remains supported on the ledge');
  }
});

test('tank responds to mounted W/S and A/D and brakes without an automatic shuttle',async t=>{
  const {tick}=await fixture(t);
  const input=(...down:string[])=>({down,pressed:[],released:[]});
  const driver={playerId:'local',componentId:'hull',seatIndex:0};
  const idle=tick({input:input('KeyW')});
  assert.equal(idle.states.hull.throttle,0);
  assert.equal(idle.states.hull.targetSpeed,0);
  const forward=tick({driver,input:input('KeyW','KeyA')});
  assert.ok(forward.commands.find((c:any)=>c.path==='body.applyForce').args[0][2]>0);
  assert.ok(forward.commands.find((c:any)=>c.path==='body.applyTorque').args[0][1]>0);
  const reverse=tick({driver,input:input('KeyS','KeyD')});
  assert.ok(reverse.commands.find((c:any)=>c.path==='body.applyForce').args[0][2]<0);
  assert.ok(reverse.commands.find((c:any)=>c.path==='body.applyTorque').args[0][1]<0);
  const brake=tick({driver,input:input('KeyW','Space'),velocity:[0,0,2]});
  assert.equal(brake.states.hull.targetSpeed,0);
  assert.ok(brake.commands.find((c:any)=>c.path==='body.applyForce').args[0][2]<0);
});

test('tank persists its driver seat and both tread loops when stopped',()=>{
  const root=model.root;
  assert.equal(root.seats.length,1);
  assert.equal(root.seats[0].fixedOrientation,true);
  assert.deepEqual(root.seats[0].rotation,[0,1,0,0]);
  assert.equal(root.decorations?.filter(d=>d.id.startsWith('track_0_')).length,32);
  assert.equal(root.decorations?.filter(d=>d.id.startsWith('track_1_')).length,32);
});

test('a ledge between downward samples supports the approaching tire before the next tick',async t=>{
  const position=[6491,28.42,630.72];
  const f=await fixture(t,{position,ground:stepGround,wall:stepWall});
  const result=f.tick({velocity:[0,0,2]});
  const front=result.commands.filter((c:any)=>c.path==='setLocalPosition'&&c.args[0][2]>3);
  assert.equal(front.length,2);
  for(const c of front) assert.ok(position[1]+c.args[0][1]-.875>=26.15,'tire must clear the upcoming vertical edge');
});


test('a tread shoe turns continuously across a wheel arc vertex', async t => {
  const f=await fixture(t);
  const path=trackPath(Array(4).fill(.76));
  const segments=path.slice(1).map((point,i)=>Math.hypot(point[0]-path[i][0],point[1]-path[i][1]));
  const perimeter=segments.reduce((sum,value)=>sum+value,0);
  const vertex=segments.slice(0,4).reduce((sum,value)=>sum+value,0);
  const pose=(offset:number)=>{
    const distance=vertex-perimeter/64+offset;
    return f.tick({states:{hull:{phase_0:distance,cycle_0:distance/perimeter}}}).commands
      .find((c:any)=>c.path==='decorations.upsert'&&c.args[0]==='track_0_0').args[1];
  };
  const before=pose(-.001),after=pose(.001);
  const rotation=new Quaternion(...before.rotation).angleTo(new Quaternion(...after.rotation));
  assert.ok(rotation<.01,`a 2 mm movement must not snap the tread through 22.5 degrees: ${rotation}`);
  assert.ok(new Vector3(...before.position).distanceTo(new Vector3(...after.position))<.003);
});

test('suspension travel preserves the belt cycle when its path length changes',async t=>{
  let raised=false;
  const f=await fixture(t,{ground:(p:number[])=>raised&&Math.abs(p[2]-622)<.25?25.5:25});
  const first=f.tick({states:{hull:{cycle_0:.99,cycle_1:.99}}});
  raised=true;
  const next=f.tick({states:first.states,tick:21});
  assert.notEqual(next.states.hull.length_1,first.states.hull.length_1);
  assert.ok(Math.abs(next.states.hull.cycle_0-.99)<1e-12);
  assert.ok(Math.abs(next.states.hull.cycle_1-.99)<1e-12);
  const moving=f.tick({states:next.states,tick:22,velocity:[0,0,2]});
  assert.ok(moving.states.hull.cycle_0!==next.states.hull.cycle_0);
  assert.ok(moving.states.hull.cycle_0>=0&&moving.states.hull.cycle_0<1);
});
