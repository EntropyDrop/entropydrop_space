// W/S drive, A/D differential steering, Space brake, Shift faster.
// The hull receives only forces/torques. Contact uses true ray distance.
export const suspensionScript = `
const p=self.getWorldPosition(), pivot=self.getPivot();
const vel=ctx.velocity, omega=ctx.angularVelocity;
const up=self.localToWorldDirection([0,1,0]);
const forward=self.localToWorldDirection([0,0,1]);
const right=self.localToWorldDirection([1,0,0]);
const rest:f64=1.25, radius:f64=1.035, spring:f64=16000, damping:f64=2300;
const lengths=new Array<f64>(8);
let grounded:i32=0, minLength:f64=rest, maxLength:f64=0, groundMin:f64=10000;
const speed:f64=vel[0]*forward[0]+vel[2]*forward[2];
const lateralSpeed:f64=vel[0]*right[0]+vel[2]*right[2];
for(let i:i32=0;i<8;i++) {
  const x:f64=(i<4?-1:1)*1.875, z:f64=(i%4==0?-3.125:i%4==1?-1:i%4==2?1:3.125);
  const offset=self.localToWorldDirection([x-pivot[0],-pivot[1],z-pivot[2]]);
  const mountX=p[0]+offset[0], mountY=p[1]+offset[1], mountZ=p[2]+offset[2];
  const previousLength:f64=self.state.getNumber("length_"+i.toString(),.75);
  const centerX:f64=mountX-up[0]*previousLength, centerZ:f64=mountZ-up[2]*previousLength;
  let surface:f64=-10000, centerGround:f64=-10000;
  const rayY:f64=mountY+1.5;
  const centerHit=ctx.world.raycast([centerX,rayY,centerZ],[0,-1,0],6);
  if(!centerHit.isNull){centerGround=rayY-centerHit.getNumber("distance");surface=centerGround+radius;groundMin=Math.min(groundMin,centerGround);}
  // Find a ledge face, then sample its top at the exact contact distance.
  // Sparse downward probes miss corners between samples. The small sweep
  // margin also covers vehicle travel before the next 20 Hz control tick.
  const horizontal:f64=Math.sqrt(forward[0]*forward[0]+forward[2]*forward[2]);
  const fx:f64=forward[0]/horizontal,fz:f64=forward[2]/horizontal;
  const margin:f64=Math.abs(speed)*ctx.deltaTime+.12;
  if(centerGround>-1000) for(let sign:i32=-1;sign<=1;sign+=2){
    const wall=ctx.world.raycast([centerX,centerGround+.05,centerZ],[fx*sign,0,fz*sign],radius+margin);
    if(!wall.isNull){
      const distance:f64=wall.getNumber("distance");
      const top=ctx.world.raycast([centerX+fx*sign*(distance+.02),rayY,centerZ+fz*sign*(distance+.02)],[0,-1,0],6);
      if(!top.isNull){
        const ground:f64=rayY-top.getNumber("distance"),along:f64=Math.max(0,distance-margin);
        surface=Math.max(surface,ground+Math.sqrt(Math.max(0,radius*radius-along*along)));
        groundMin=Math.min(groundMin,ground);
      }
    }
  }
  const raw:f64=(mountY-surface)/Math.max(.55,up[1]);
  const length:f64=Math.max(.12,Math.min(rest,raw));lengths[i]=length;
  if(raw<rest&&surface>-1000) {
    grounded++;
    const pointVelocity:f64=vel[1]+omega[2]*offset[0]-omega[0]*offset[2];
    const load:f64=Math.max(0,Math.min(40000,spring*(rest-raw)-damping*pointVelocity));
    self.applyForceAt([0,load,0],[x,0,z]);
  }
  const wheel=self.child("wheel_"+i.toString());
  if(wheel) {
    wheel.setLocalPosition([x-pivot[0],-length-pivot[1],z-pivot[2]]);
    wheel.setLocalSpin([1,0,0],(speed-omega[1]*x)/.875*60/(2*Math.PI));
  }
  minLength=Math.min(minLength,length);maxLength=Math.max(maxLength,length);
  self.state.setNumber("length_"+i.toString(),length);
}
const driving:bool=!ctx.driver.isNull;
const brake:bool=ctx.input.down("Space");
const throttle:f64=driving&&!brake?(ctx.input.down("KeyW")?1:0)-(ctx.input.down("KeyS")?1:0):0;
const steer:f64=driving&&!brake?(ctx.input.down("KeyA")?1:0)-(ctx.input.down("KeyD")?1:0):0;
const target:f64=throttle*(ctx.input.down("Shift")?4.0:2.4);
if(grounded>0) {
  const force:f64=Math.max(-38000,Math.min(38000,(target-speed)*(brake?24000:16000)));
  const sideForce:f64=Math.max(-24000,Math.min(24000,-lateralSpeed*21000));
  self.body.applyForce([forward[0]*force+right[0]*sideForce,0,forward[2]*force+right[2]*sideForce]);
  self.body.applyTorque([-omega[0]*20000-up[2]*9000,
    (steer*.65-omega[1])*42000,-omega[2]*20000+up[0]*9000]);
}
// Each closed belt follows four independently suspended wheel stations.
for(let side:i32=0;side<2;side++) {
  const base:i32=side*4, x:f64=side==0?-1.875:1.875;
  const beltSpeed:f64=speed-omega[1]*x;
  let changed:bool=ctx.tick<3||Math.abs(beltSpeed)>.01;
  for(let k:i32=0;k<4;k++) if(Math.abs(lengths[base+k]-self.state.getNumber("draw_"+(base+k).toString(),-10))>.004) changed=true;
  if(!changed) continue;
  const zz=new Array<f64>(), yy=new Array<f64>();
  for(let k:i32=0;k<4;k++){zz.push((k==0?-3.125:k==1?-1:k==2?1:3.125));yy.push(-lengths[base+k]+.955);}
  for(let k:i32=1;k<=8;k++){const a:f64=<f64>k*Math.PI/8;zz.push(3.125+.955*Math.sin(a));yy.push(-lengths[base+3]+.955*Math.cos(a));}
  for(let k:i32=2;k>=0;k--){zz.push((k==0?-3.125:k==1?-1:k==2?1:3.125));yy.push(-lengths[base+k]-.955);}
  for(let k:i32=1;k<=8;k++){const a:f64=<f64>k*Math.PI/8;zz.push(-3.125-.955*Math.sin(a));yy.push(-lengths[base]-.955*Math.cos(a));}
  const segments=new Array<f64>();let perimeter:f64=0;
  for(let k:i32=0;k<22;k++){const dz:f64=zz[k+1]-zz[k],dy:f64=yy[k+1]-yy[k];const n:f64=Math.sqrt(dz*dz+dy*dy);segments.push(n);perimeter+=n;}
  // Store a fraction of the closed loop. Changing suspension travel must not
  // reinterpret a wrapped metre offset using a different perimeter.
  let phase:f64=self.state.getNumber("cycle_"+side.toString(),self.state.getNumber("phase_"+side.toString())/perimeter);
  phase+=beltSpeed*ctx.deltaTime/perimeter;
  phase=((phase%1)+1)%1;
  self.state.setNumber("cycle_"+side.toString(),phase);
  const tangents=new Array<f64>();
  for(let k:i32=0;k<22;k++) {
    const prev:i32=(k+21)%22;
    tangents.push(Math.atan2((yy[k]-yy[prev])/segments[prev]+(yy[k+1]-yy[k])/segments[k],
      (zz[k]-zz[prev])/segments[prev]+(zz[k+1]-zz[k])/segments[k]));
  }
  for(let j:i32=0;j<32;j++) {
    let distance:f64=(((<f64>j+.5)/32+phase)%1)*perimeter;let k:i32=0;
    while(k<21&&distance>segments[k]){distance-=segments[k];k++;}
    const t:f64=distance/segments[k], z:f64=zz[k]+(zz[k+1]-zz[k])*t;
    let y:f64=yy[k]+(yy[k+1]-yy[k])*t;
    // Interpolate the tangent across vertices instead of snapping the shoe
    // through a 22.5-degree turn whenever its center crosses an arc segment.
    const turn:f64=tangents[(k+1)%22]-tangents[k];
    const angle:f64=-(tangents[k]+Math.atan2(Math.sin(turn),Math.cos(turn))*t);
    // Only lower-run shoes need extra terrain probes; total remains below 64.
    if(k>=11&&k<=13) {
      const wx:f64=p[0]+right[0]*(x-pivot[0])+up[0]*(y-pivot[1])+forward[0]*(z-pivot[2]);
      const wy:f64=p[1]+right[1]*(x-pivot[0])+up[1]*(y-pivot[1])+forward[1]*(z-pivot[2]);
      const wz:f64=p[2]+right[2]*(x-pivot[0])+up[2]*(y-pivot[1])+forward[2]*(z-pivot[2]);
      const hit=ctx.world.raycast([wx,wy+2,wz],[0,-1,0],4);
      if(!hit.isNull){const surface:f64=wy+2-hit.getNumber("distance")+.09;if(surface>wy)y+=(surface-wy)/Math.max(.55,up[1]);}
    }
    const patch=Value.object().setVector("position",[x,y,z])
      .setVector("rotation",[Math.sin(angle/2),0,0,Math.cos(angle/2)])
      .setVector("scale",[.9,.16,perimeter/32*.94]);
    self.decorations.upsert("track_"+side.toString()+"_"+j.toString(),patch);
  }
  for(let k:i32=0;k<4;k++) self.state.setNumber("draw_"+(base+k).toString(),lengths[base+k]);
}
self.state.setNumber("grounded",grounded);self.state.setNumber("groundY",groundMin);
self.state.setNumber("minLength",minLength);self.state.setNumber("maxLength",maxLength);
self.state.setNumber("speed",speed);self.state.setNumber("throttle",throttle);self.state.setNumber("steer",steer);
self.state.setBoolean("driver",driving);self.state.setNumber("targetSpeed",target);
`;
