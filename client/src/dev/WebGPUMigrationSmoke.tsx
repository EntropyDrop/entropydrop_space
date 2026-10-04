import * as THREE from 'three/webgpu';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CharacterSkinPreview } from '../ui/react/components/CharacterSkinPreview.tsx';
import { DEFAULT_PLAYER_SKIN_URL } from '../bootstrap/SpaceBootstrap.ts';
import { ENTITY_PREVIEW_LAYER } from '../engine/render/SceneRenderer.ts';
import { InventoryThumbnailRenderer } from '../engine/render/InventoryThumbnailRenderer.ts';
import { Contraption } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { hookSceneMaterials } from '@entropydrop/space-engine/torus/TorusWorld.ts';

/** Loopback-only, ephemeral fixture for the actual production render paths. */
export function installWebGPUMigrationSmoke(game: any) {
  const sr = game.sceneRenderer;
  const panel = document.createElement('section');
  panel.id = 'dev-webgpu-migration';
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:20000;background:#10202eee;color:white;padding:12px;max-width:720px;max-height:70vh;overflow:auto;font:12px monospace';
  const status = document.createElement('pre'); status.style.whiteSpace='pre-wrap';
  const previews = document.createElement('div'); previews.style.display='flex';
  const report: any = { backend: sr.renderer.backend.isWebGPUBackend ? 'webgpu' : 'INVALID', cases: [], errors: [] };
  const update = () => { status.textContent = JSON.stringify(report,null,2); };
  const button = (name: string, action: () => void) => { const b=document.createElement('button');b.textContent=name;b.onclick=action;panel.append(b);return b; };
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const device = sr.renderer.backend.device as GPUDevice;
  const recordError = (message: string) => { if(!report.errors.includes(message)&&report.errors.length<12)report.errors.push(message); update(); };
  window.addEventListener('error', event => recordError(event.message));
  window.addEventListener('unhandledrejection', event => recordError(String(event.reason)));
  device.addEventListener('uncapturederror', event => { const message=(event as GPUUncapturedErrorEvent).error.message; if(!report.errors.includes(message)&&report.errors.length<12)report.errors.push(message); update(); });
  const pixels = (canvas: HTMLCanvasElement) => {
    const copy=document.createElement('canvas');copy.width=64;copy.height=64;
    const ctx=copy.getContext('2d')!;ctx.drawImage(canvas,0,0,64,64);
    const data=ctx.getImageData(0,0,64,64).data;const colors=new Set<number>();let opaque=0;
    for(let i=0;i<data.length;i+=4) {colors.add(data[i]<<16|data[i+1]<<8|data[i+2]);if(data[i+3])opaque++;}
    return {colors:colors.size,opaque};
  };
  const save = (url: string, filename: string) => {const a=document.createElement('a');a.href=url;a.download=filename;a.click();};
  button('Run WebGPU migration checks', async () => {
    report.cases=[];report.errors=[];report.complete=false;
    try {
      for(const quality of ['low','medium','high','ultra','low','ultra']) {
        sr.setLightingQuality(quality);sr.setShadowsEnabled(true);
        for(let i=0;i<4;i++) await frame();
        sr.render();await device.queue.onSubmittedWorkDone();
        // Re-render and capture within one browser task, before presentation clears the canvas.
        sr.render();
        report.cases.push({quality,shadow:sr.sunLight.shadow.map?.width ?? 0,...pixels(sr.renderer.domElement)});update();
      }
      const adaptiveUpdate=sr.updateAdaptiveResolution;
      sr.updateAdaptiveResolution=()=>{};
      try {
        for(const scale of [.5, 1]) {
          sr.setResolutionScale(scale);
          for(let i=0;i<4;i++)await frame();
          sr.render();await device.queue.onSubmittedWorkDone();sr.render();
          report.cases.push({quality:sr.getLightingQuality(),scale,...pixels(sr.renderer.domElement)});update();
        }
      } finally { sr.updateAdaptiveResolution=adaptiveUpdate;sr.setResolutionScale(1); }
      const item={kind:'blockset',name:'WebGPU fixture',blocks:[{dx:0,dy:0,dz:0,size:1,color:0x40bbff},{dx:1,dy:0,dz:0,size:.5,color:0xff6633,materialId:1}]};
      const thumbnails=InventoryThumbnailRenderer.getInstance();
      let url=thumbnails.getThumbnail(item);
      const deadline=performance.now()+15000;
      while(!url && performance.now()<deadline) {await frame();url=thumbnails.getThumbnail(item);}
      if(!url) throw new Error('Thumbnail readback did not complete');
      const img=document.createElement('img');img.src=url;img.alt='WebGPU inventory thumbnail';img.style.cssText='width:128px;height:128px;object-fit:contain';previews.append(img);await img.decode();
      report.cases.push({thumbnail:img.naturalWidth});
      const skin=document.createElement('div');previews.append(skin);
      createRoot(skin).render(<CharacterSkinPreview url={DEFAULT_PLAYER_SKIN_URL} model="strong"/>);
      const blocks=[0,1,2].map(x=>({localX:x,localY:0,localZ:0,size:1,block:1,color:x===1?0xff6633:0x40bbff,materialId:x===1?1:0,entityId:'root'}));
      const entity=new Contraption('webgpu-fixture',blocks,sr.camera.position.clone(),sr.scene);
      const highlight=entity.buildNodeHighlightBox('root');entity.rootGroup.add(highlight.group);
      entity.rootGroup.traverse(object => object.layers.set(ENTITY_PREVIEW_LAYER));
      hookSceneMaterials(entity.rootGroup);
      const canvas=document.createElement('canvas');canvas.style.cssText='width:240px;height:240px';canvas.setAttribute('aria-label','WebGPU entity preview');previews.append(canvas);
      sr.setEntityPreviewCanvas(canvas);sr.setEntityPreviewTarget(entity);
      for(let i=0;i<120 && !sr.previewReady;i++)await frame();
      sr.renderEntityPreview(entity);await sr.previewRenderer.backend.device.queue.onSubmittedWorkDone();sr.renderEntityPreview(entity);
      report.cases.push({entityPreview:pixels(canvas)});
      const skinDeadline=performance.now()+15000;
      while(skin.querySelector('canvas')?.dataset.renderReady!=='true' && performance.now()<skinDeadline)await frame();
      if(skin.querySelector('canvas')?.dataset.renderReady!=='true')throw new Error('Skin preview did not render');
      report.cases.push({skinPreview:skin.querySelector('canvas')?.dataset.renderBackend});
      if(report.cases.some((value:any)=>value.quality && (value.colors<50||value.opaque!==4096)))throw new Error('A quality mode produced an empty frame');
      await device.queue.onSubmittedWorkDone();await frame();
      report.complete=report.errors.length===0;update();
    } catch(error) {report.errors.push(String(error));update();}
  });
  for(const quality of ['low','medium','high','ultra'])button(`View ${quality}`,()=>{sr.setLightingQuality(quality);sr.setShadowsEnabled(true);});
  button('Near view',()=>{game.controller.pitch=-.85;game.controller.yaw=Math.PI/2;});
  button('Save WebGPU screenshot',()=>save(sr.captureCleanScreenshotPng(),'space-webgpu-migrated.png'));
  button('Save migration report',()=>save(URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),'space-webgpu-migration.json'));
  panel.append(previews,status);document.body.append(panel);update();
}
