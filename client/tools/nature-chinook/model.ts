import type { PortableComponent, PortableEntity } from '../../../engine/src/storage/InventoryTypes.ts';

export const anchor = [6536, 27, 625] as const;
const olive = 0x69704a, shade = 0x525939, edge = 0x828765;
const rubber = 0x222829, steel = 0x647071, glass = 0x234b58, highlight = 0x91b4bc;
type Cell = { x: number; y: number; z: number; color: number; material: number };
type V3 = [number, number, number];

// Author at 1/8 m, then collapse every completely filled, single-color cubic
// metre to one standard voxel. No separate decoration draws or external assets.
class Grid {
  cells = new Map<string, Cell>();
  shape(lo: V3, hi: V3, test: (x: number, y: number, z: number) => boolean,
    color: number | ((x: number, y: number, z: number) => number), material = 0) {
    for (let x = Math.floor(lo[0] * 8); x < Math.ceil(hi[0] * 8); x++)
      for (let y = Math.floor(lo[1] * 8); y < Math.ceil(hi[1] * 8); y++)
        for (let z = Math.floor(lo[2] * 8); z < Math.ceil(hi[2] * 8); z++) {
          const px = (x + .5) / 8, py = (y + .5) / 8, pz = (z + .5) / 8;
          if (test(px, py, pz)) this.cells.set(`${x},${y},${z}`, {
            x, y, z, color: typeof color === 'number' ? color : color(px, py, pz), material,
          });
        }
  }
  box(center: V3, size: V3, color: number, yaw = 0, material = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw), [w, h, d] = size.map(v => v / 2);
    const bx = Math.abs(c * w) + Math.abs(s * d), bz = Math.abs(s * w) + Math.abs(c * d);
    this.shape([center[0] - bx, center[1] - h, center[2] - bz],
      [center[0] + bx, center[1] + h, center[2] + bz], (x,y,z) => {
        const dx = x - center[0], dz = z - center[2];
        return Math.abs(c * dx - s * dz) <= w && Math.abs(s * dx + c * dz) <= d;
      }, color, material);
  }
  ellipsoid(center: V3, radii: V3, color: number) {
    this.shape(center.map((v,i) => v - radii[i]) as V3, center.map((v,i) => v + radii[i]) as V3,
      (x,y,z) => ((x-center[0])/radii[0])**2 + ((y-center[1])/radii[1])**2 + ((z-center[2])/radii[2])**2 <= 1, color);
  }
  blocks(): PortableComponent['blocks'] {
    const buckets = new Map<string, Cell[]>();
    for (const cell of this.cells.values()) {
      const key = [cell.x, cell.y, cell.z].map(v => Math.floor(v / 8)).join(',');
      const bucket = buckets.get(key) || []; bucket.push(cell); buckets.set(key, bucket);
    }
    const result: PortableComponent['blocks'] = [];
    for (const [key, cells] of buckets) {
      const [dx,dy,dz] = key.split(',').map(Number), first = cells[0];
      if (cells.length === 512 && cells.every(c => c.color === first.color && c.material === first.material)) {
        result.push({ dx,dy,dz,color:first.color,materialId:first.material });
      } else for (const c of cells) {
        // Partial cubic metres need only their exterior skin. Keep solid
        // standard cores above, and remove invisible micro-voxel interiors.
        const enclosed = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
          .every(([x,y,z]) => this.cells.has(`${c.x+x},${c.y+y},${c.z+z}`));
        if (!enclosed) result.push({ dx,dy,dz,
          mx:c.x-dx*8,my:c.y-dy*8,mz:c.z-dz*8,size:.125,color:c.color,materialId:c.material });
      }
    }
    return result;
  }
}

export function createChinook(): PortableEntity {
  const body = new Grid();
  // Rounded rectangular cabin, a sloping glazed nose, and tapered cargo ramp.
  body.shape([-1.875,-1.5,-8], [1.875,1.625,7.75], (x,y,z) => {
    const nose = Math.max(0, Math.min(1, (z + 8) / 2.4));
    const rear = Math.max(.55, Math.min(1, (8.5-z)/2));
    const rx = (1.0 + .75*nose) * rear, ry = 1.1 + .45*nose;
    return (Math.abs(x)/rx)**4 + (Math.abs(y+.05)/ry)**4 <= 1;
  }, (x,y,z) => {
    if (z < -5.65 && y > .2 && y < 1.12 && Math.abs(x) > .12) {
      if (Math.abs(z+6.4)<.065 || Math.abs(x-1.1)<.065 || Math.abs(x+1.1)<.065) return edge;
      return y > .93 ? highlight : glass;
    }
    if (Math.abs(x)>1.55 && [-3.6,-1.35,.9,3.15].some(w => (z-w)**2+(y-.48)**2<.135)) return glass;
    if (y<-.95) return shade;
    if (Math.abs(x)>1.62 && Math.abs(y+.63)<.07) return edge;
    if (z>6.9 && y<.85 && Math.abs(x)<1.0) return shade;
    return olive;
  });
  // Lower fuel sponsons and cargo door frames.
  for (const side of [-1,1]) {
    body.ellipsoid([side*1.625,-.95,.2],[.5,.48,5.9],shade);
    body.box([side*1.75,-.73,-.1],[.125,.125,10.5],edge);
    body.box([side*1.75,.0,4.72],[.125,1.6,.125],shade);
    body.box([side*1.75,.76,4.15],[.125,.125,1.25],shade);
    body.box([side*1.75,-.75,4.15],[.125,.125,1.25],shade);
    body.box([side*1.875,-.25,4.55],[.125,.125,.3],steel);
    // Raised rear engine nacelles and black exhaust openings.
    body.ellipsoid([side*1.25,2.25,4.25],[.65,.6,1.9],shade);
    body.box([side*1.25,2.25,5.85],[.75,.625,.125],rubber);
    body.box([side*1.25,2.25,5.94],[.375,.375,.125],0x131819);
    body.box([side*1.25,2.25,2.65],[.625,.375,.125],rubber);
    // Four fixed landing-gear stations: chrome struts and thick rubber wheels.
    for (const z of [-4.9,4.8]) {
      body.box([side*1.65,-1.625,z],[.25,.75,.25],steel);
      body.box([side*1.8,-1.875,z],[.625,.25,.25],steel);
      body.shape([side*2-.25,-2.625,z-.5],[side*2+.25,-1.625,z+.5],
        (_x,y,pz)=>(y+2.125)**2+(pz-z)**2<=.25,rubber);
      body.box([side*2.25,-2.125,z],[.125,.25,.25],steel);
    }
    body.box([side*1.875,.3,-4.5],[.125,.125,.25],side<0?0xff4141:0x62f39b,0,1);
    // Small geometric "47" service marking on each side.
    const glyphs = ['10110111','10110001','11110010','00110100','00110100'];
    for (let row=0;row<glyphs.length;row++) for (let col=0;col<glyphs[row].length;col++) {
      if (glyphs[row][col]==='1') body.box([side*1.75,.1-row*.125,1.5+col*.125],[.125,.125,.125],0xd2d1b2);
    }
  }
  // The rear transmission tower is distinctly taller than the front tower.
  body.shape([-.9,1.1,3.2],[.9,3.875,6.4],(x,y,z)=>{
    const width=.9-(y-1.1)*.12;
    return Math.abs(x)<width && z>3.2+(y-1.1)*.6 && z<6.4-(y-1.1)*.1;
  },olive);
  body.ellipsoid([0,1.6,-5.1],[.85,.75,1.25],olive);
  body.box([0,2.375,-5.25],[.375,.75,.375],steel);
  body.box([0,4,5.25],[.375,.25,.375],steel);
  body.box([0,1.65,-.2],[.625,.25,7.5],shade);
  body.box([0,1.98,1],[.125,.625,.125],rubber);
  body.box([0,-1.6,1],[.125,.625,.125],rubber);
  body.box([0,3.85,5.75],[.25,.125,.25],0xff493c,0,1);
  body.box([0,-.1,-8],[.25,.25,.125],0xffecc6,0,1);

  const root: PortableComponent = {
    id:'fuselage',name:'CH-47 Chinook | Tandem Rotor',pivot:[0,0,0],
    body:{type:'kinematic',mass:12000,useGravity:false,collisionEnabled:true},
    blocks:body.blocks(),children:[],decorations:[],seats:[],scriptLanguage:'assemblyscript',
    script:`// Deliberately bounded hover patrol; this is animation, not an aerodynamic flight model.
const phase: f64 = ctx.time * 0.22;
self.setLocalPosition([${anchor[0]} + Math.sin(phase) * 1.5,
  ${anchor[1]} + Math.sin(ctx.time * 0.85) * 0.3,
  ${anchor[2]} + (Math.cos(phase) - 1.0) * 1.0]);
self.setLocalEuler([Math.sin(phase) * 0.02, Math.sin(phase * 0.6) * 0.08,
  -Math.cos(phase) * 0.025]);`,
  };
  for (const rear of [false,true]) {
    const rotor = new Grid(), initial = rear ? Math.PI/3 : 0;
    rotor.ellipsoid([0,0,0],[.5,.25,.5],steel);
    for (let i=0;i<3;i++) {
      const angle=initial+i*Math.PI*2/3;
      rotor.box([Math.sin(angle)*4.4,0,Math.cos(angle)*4.4],[.625,.125,7.75],rubber,angle);
      rotor.box([Math.sin(angle)*8.15,0,Math.cos(angle)*8.15],[.625,.125,.375],0xc5b57a,angle);
      rotor.box([Math.sin(angle)*.65,.0,Math.cos(angle)*.65],[.25,.25,.75],steel,angle);
    }
    root.children.push({id:rear?'aft_rotor':'forward_rotor',name:rear?'Aft three-blade rotor':'Forward three-blade rotor',
      pivot:[0,0,0],localPosition:[0,rear?4.375:3,-5.25*(rear?-1:1)],
      body:{type:'kinematic',mass:250,useGravity:false,collisionEnabled:false},
      blocks:rotor.blocks(),children:[],decorations:[],seats:[],scriptLanguage:'assemblyscript',
      script:`self.setLocalSpin([0, 1, 0], ${rear?-150:150});`,
    });
  }
  return {type:'space-entity',version:8,root,constraints:[]};
}
