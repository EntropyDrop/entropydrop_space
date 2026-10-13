import { anchor } from './model.ts';
export { sample } from '../nature-orb/probe.ts';
export { anchor };
export const operationId = '560c19ce-1a94-419e-8cf6-5465aae71fab';
export const worldId = '00000000-0000-4000-8000-000000000002';

export function configure(game: any) {
  const saved={yaw:game.controller.yaw,pitch:game.controller.pitch,
    resolution:game.sceneRenderer.getResolutionScaleState()};
  game.sceneRenderer.setResolutionScale(1);
  const eye=game.playerPhysics.getEyePosition();
  const dx=anchor[0]-eye.x,dy=anchor[1]+1-eye.y,dz=anchor[2]-eye.z;
  game.controller.yaw=Math.atan2(-dx,-dz);
  game.controller.pitch=Math.atan2(dy,Math.hypot(dx,dz));
  return saved;
}

// Explicit manual action, never part of application startup. Repeat only with
// the unchanged export, world and operation ID to recover an uncertain create.
export async function create(game: any) {
  if(location.hostname!=='localhost'||game.entitySync.apiOrigin!=='http://localhost:8000'
    ||game.contraptionManager.getWorldInfo().id!==worldId) throw new Error('Local Nature only.');
  const world=await game.entitySync.client.request('/../../nature');
  if(world.id!==worldId) throw new Error('World mismatch.');
  const response=await fetch(new URL('./ch47.entity.pb',import.meta.url));
  if(!response.ok) throw new Error('Export missing.');
  const definition=new Uint8Array(await response.arrayBuffer());
  return game.entitySync.client.create({operation_id:operationId,definition,
    position:{x_cm:anchor[0]*100,y_cm:anchor[1]*100,z_cm:anchor[2]*100},
    yaw_quarter_turns:0,desired_run_state:'stopped'});
}
