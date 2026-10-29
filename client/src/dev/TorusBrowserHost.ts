if (!import.meta.env.DEV || location.hostname !== 'localhost') throw Error('Local DEV only');
const parameters=new URL(location.href).searchParams;
const terrain=parameters.get('terrain') ?? 'nature';
if(!['nature','copper-metropolis','aether-archipelago'].includes(terrain))throw Error('Unknown terrain');
(window as any).torusTerrain=terrain;
const profile=parameters.get('profile');
if(profile && !['fixed','adaptive','maintenance'].includes(profile))throw Error('Unknown profile');
(window as any).torusProfile=profile;
const frame=document.querySelector<HTMLIFrameElement>('#fixture')!,status=document.querySelector('#status')!,button=document.querySelector<HTMLButtonElement>('#run')!;
const save=async(name:string,bytes:BodyInit)=>{const r=await fetch(`http://127.0.0.1:${profile?54387:54381}/${profile?profile+'/':''}${terrain}/${name}`,{method:'POST',body:bytes});if(!r.ok)throw Error(`Capture failed: ${r.status}`);};
(window as any).torusHost={
 async status(value:any){
  status.textContent=JSON.stringify(value);await save('status.json',JSON.stringify(value));
  if(value.state==='complete'&&parameters.get('suite')==='1'){
   const entries=['fixed','adaptive','maintenance'].flatMap(p=>['nature','copper-metropolis','aether-archipelago'].map(t=>({p,t})));
   const next=entries[entries.findIndex(e=>e.p===profile&&e.t===terrain)+1];
   if(next){const url=new URL(location.href);url.searchParams.set('profile',next.p);url.searchParams.set('terrain',next.t);url.searchParams.set('autorun','1');setTimeout(()=>location.replace(url),500);}
  }
 },
 async save(name:string,value:any){await save(name,name.endsWith('.png')?Uint8Array.from(atob(value.split(',')[1]),c=>c.charCodeAt(0)):JSON.stringify(value));},
};
button.onclick=()=>{button.disabled=true;frame.onload=()=>{const script=frame.contentDocument!.createElement('script');script.type='module';script.src=new URL(profile?'../src/dev/TorusLodAlignmentChild.ts':'../src/dev/TorusBrowserChild.ts',location.href).href;frame.contentDocument!.body.append(script);};frame.src=`/space/app/?world=torus-compare-${terrain}&dev_offline=1&dev_lod=world&dev_dpr=1&dev_msaa=0`;};
if(parameters.get('autorun')==='1')button.click();
