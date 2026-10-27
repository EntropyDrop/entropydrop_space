/** Execute Java's mapping against the actual Space camera projection, not a second JS formula. */
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {Vector3,Quaternion} from 'three';
import {bendPoint,bendPointForView,bendFrameQuaternion,setTorusViewCorrection,setWorldProjection} from '../../engine/src/torus/TorusWorld.ts';
const joml=process.argv[2];if(!joml)throw Error('Usage: node validate-projection.ts /path/to/joml-1.10.5.jar');
const java=process.env.JAVA_HOME?`${process.env.JAVA_HOME}/bin/`:'';
const out=resolve('tools/minecraft-torus/build/projection-check');mkdirSync(out,{recursive:true});
const build=spawnSync(java+'javac',['-cp',joml,'-d',out,'tools/minecraft-torus/src/main/java/com/entropydrop/torus/TorusMath.java','tools/minecraft-torus/validation/ProjectionCheck.java'],{encoding:'utf8'});if(build.status)throw Error(build.stderr);
setWorldProjection('torus');let state=42;const random=()=>((state=Math.imul(state,1664525)+1013904223|0)>>>0)/4294967296;
const rows:string[]=[];
for(const camera of [new Vector3(8192.5,180,1024.5),new Vector3(0,18,0),new Vector3(12000,240,520)]){
 setTorusViewCorrection(camera);const origin=bendPoint(camera.x,camera.y,camera.z),q=bendFrameQuaternion(camera.x,camera.y,camera.z,new Quaternion()).invert();
 for(let i=0;i<2000;i++){
  const p=i<1000?new Vector3(camera.x+(random()-.5)*600,camera.y+(random()-.5)*600,camera.z+(random()-.5)*600):new Vector3(random()*16384,random()*256,random()*2048);
  const expected=bendPointForView(p.x,p.y,p.z).sub(origin).applyQuaternion(q);rows.push([...camera.toArray(),...p.toArray(),...expected.toArray()].join(' '));
 }
}
const result=spawnSync(java+'java',['-cp',out+':'+joml,'ProjectionCheck'],{input:rows.join('\n'),encoding:'utf8'});if(result.status)throw Error(result.stderr);console.log(result.stdout.trim());
