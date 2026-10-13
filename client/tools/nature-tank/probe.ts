import { anchor,courseOrigin,createCourse } from './model.ts';
export { sample } from '../nature-orb/probe.ts';
export { anchor,courseOrigin };
export const worldId='00000000-0000-4000-8000-000000000002';
export const createdEntityId='5e6dd2c8-3cd7-447f-b9b5-8a13af1cc19c';
export const courseOperation='5d38bcc7-93e8-46c0-a6b2-cbdaa5ddcb80';
async function guard(game:any) {
  if(location.hostname!=='localhost'||game.entitySync.apiOrigin!=='http://localhost:8000'
    ||game.contraptionManager.getWorldInfo().id!==worldId) throw new Error('Local Nature only.');
  const world=await game.entitySync.client.request('/../../nature');
  if(world.id!==worldId) throw new Error('World mismatch.');
}
async function bytes(name:string) {
  const response=await fetch(new URL('./'+name+'.pb',import.meta.url));
  if(!response.ok) throw new Error('Export missing.');
  return new Uint8Array(await response.arrayBuffer());
}
export function inspectCourse(game:any) {
  return createCourse().blocks.map(b=>({x:courseOrigin[0]+b.dx,y:courseOrigin[1]+b.dy,
    z:courseOrigin[2]+b.dz,existing:game.world.getBlock(courseOrigin[0]+b.dx,courseOrigin[1]+b.dy,courseOrigin[2]+b.dz)}));
}
export async function buildCourse(game:any) {
  await guard(game);
  const definition=await bytes('course');
  return game.entitySync.client.request('/../blocksets/build',{method:'POST',body:JSON.stringify({
    operation_id:courseOperation,created_at_ms:Date.parse('2026-10-12T18:47:00Z'),
    definition_base64:btoa(String.fromCharCode(...definition)),
    position:{x_cm:courseOrigin[0]*100,y_cm:courseOrigin[1]*100,z_cm:courseOrigin[2]*100},yaw_quarter_turns:0})});
}
export async function create(game:any) {
  await guard(game);
  // This fixture is already persisted. Never duplicate it or replay an old
  // operation id against a changed model definition.
  return game.entitySync.client.get(createdEntityId);
}
export function configure(game:any) {
  const p=game.playerPhysics;
  const saved={position:p.position.toArray(),flying:p.isFlying,yaw:game.controller.yaw,pitch:game.controller.pitch,
    resolution:game.sceneRenderer.getResolutionScaleState()};
  p.isFlying=true;p.position.set(6518,32,635);p.velocity.set(0,0,0);
  game.sceneRenderer.setResolutionScale(1);
  const eye=p.getEyePosition(),dx=6491-eye.x,dy=27-eye.y,dz=635-eye.z;
  game.controller.yaw=Math.atan2(-dx,-dz);game.controller.pitch=Math.atan2(dy,Math.hypot(dx,dz));
  return saved;
}
export function telemetry(tank:any) {
  const state=tank.getComponentState(tank.rootComponentId);
  return {time:performance.now(),tick:tank.tickCount,position:tank.position.toArray(),
    velocity:tank.velocity.toArray(),rotation:tank.quaternion.toArray(),status:tank.scriptStatus,error:tank.scriptError,
    state:structuredClone(state),wheels:[...tank.entityNodes.values()].filter((n:any)=>n.id.startsWith('wheel_'))
      .map((n:any)=>({id:n.id,position:n.localPosition.toArray(),angularVelocity:n.localAngularVelocity.toArray()}))};
}
