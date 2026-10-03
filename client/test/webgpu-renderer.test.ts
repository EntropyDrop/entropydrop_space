import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { SpaceRenderer } from '../src/engine/render/SpaceRenderer.ts';

test('production renderer never silently selects the WebGL fallback', async () => {
  const canvas = {width:1,height:1,style:{},addEventListener(){},removeEventListener(){}} as unknown as HTMLCanvasElement;
  const renderer = new SpaceRenderer({canvas});
  assert.equal((renderer as any)._getFallback, null);
  assert.equal((renderer.backend as any).isWebGPUBackend, true);
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  try { await assert.rejects(renderer.initialize(), /WebGPU is required/); }
  finally { if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete (globalThis as any).navigator; }
});

test('production 3D paths contain no legacy renderer or GLSL shader hooks', () => {
  const scan=(url:URL) => {
    for(const file of readdirSync(url,{withFileTypes:true})) {
      if(file.name==='dev')continue;
      const next=new URL(file.name+(file.isDirectory()?'/':''),url);
      if(file.isDirectory())scan(next);
      else if(/\.tsx?$/.test(file.name)) {
        assert.doesNotMatch(readFileSync(next,'utf8'), /\bnew\s+(?:THREE\.)?(?:WebGLRenderer|ShaderMaterial|RawShaderMaterial)\b|\.onBeforeCompile\s*=/,next.pathname);
      }
    }
  };
  scan(new URL('../src/',import.meta.url));scan(new URL('../../engine/src/',import.meta.url));
});
