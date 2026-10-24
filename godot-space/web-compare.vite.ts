import { defineConfig, mergeConfig } from 'vite';
import original from '../client/vite.config.js';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const project = import.meta.dirname;
const surfaces = resolve(project,'../.local/godot-web-surfaces/copper-metropolis');
export default defineConfig(env => mergeConfig(original(env), {
  root: resolve(project,'../client'),
  server: {host:'127.0.0.1',port:5188,strictPort:true,hmr:false},
  plugins:[{
    name:'local-copper-native-comparison',
    enforce:'pre',
    transform(code,id) {
      if(id.split('?')[0].endsWith('/src/dev/OfflineSurface.ts')) {
        if(!code.includes('export function startOfflineSurface(world: World, repeatWorld = false) {'))
          throw new Error('OfflineSurface entry changed; comparison adapter was not installed.');
        return {
        code:`import {startComparisonSurface} from ${JSON.stringify(resolve(project,'web-compare/bridge.ts'))};\n`+
          code.replace('export function startOfflineSurface(world: World, repeatWorld = false) {',
            'export function startOfflineSurface(world: World, repeatWorld = false) {\n if(new URLSearchParams(location.search).has("native_comparison")) return startComparisonSurface(world);'),
        map:null,
        };
      }
    },
    configureServer(server) {
      server.middlewares.use('/__torus_comparison__',(req,res)=>{
        const path=(req.url||'').split('?')[0];
        if(req.method==='GET' && (path==='/manifest'||/^\/surface\/\d+_\d+_(1|2|4|8|16|32|64)\.bin\.gz$/.test(path))) {
          const file=resolve(surfaces,path==='/manifest'?'manifest.json':path.slice('/surface/'.length));
          if(!existsSync(file)){res.statusCode=503;res.end('Map generation in progress');return;}
          res.setHeader('Content-Type',path==='/manifest'?'application/json':'application/octet-stream');
          if(path!=='/manifest')res.setHeader('Content-Encoding','gzip');
          createReadStream(file).pipe(res);return;
        }
        if(req.method==='POST' && /^\/matched\/(baseline|fine)\/(manifest\.json|mask\.bin|mesh-\d+\.bin)$/.test(path) && req.headers.origin==='http://127.0.0.1:5188') {
          const chunks:Buffer[]=[];let size=0;
          req.on('data',chunk=>{size+=chunk.length;if(size>100_000_000)req.destroy();else chunks.push(chunk);});
          req.on('end',()=>{const bytes=Buffer.concat(chunks),root=resolve(project,path.split('/')[2]==='fine'?'matched-lod-fine/data':'matched-lod/data');mkdirSync(root,{recursive:true});
            writeFileSync(resolve(root,path.split('/').at(-1)!),bytes);res.setHeader('Content-Type','application/json');
            res.end(JSON.stringify({sha256:createHash('sha256').update(bytes).digest('hex')}));});return;
        }
        if(req.method==='POST' && path==='/image' && req.headers.origin==='http://127.0.0.1:5188') {
          const chunks:Buffer[]=[];let size=0;
          req.on('data',chunk=>{size+=chunk.length;if(size>32_000_000)req.destroy();else chunks.push(chunk);});
          req.on('end',()=>{const bytes=Buffer.concat(chunks);
            if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'){res.statusCode=400;res.end('Invalid PNG');return;}
            const name=`copper-web-${Date.now()}.png`;mkdirSync(resolve(project,'results'),{recursive:true});
            writeFileSync(resolve(project,'results',name),bytes);res.end(`SAVED ${name}`);});return;
        }
        if(req.method==='POST' && path==='/result' && req.headers.origin==='http://127.0.0.1:5188') {
          let body='';req.on('data',chunk=>{body+=chunk;if(body.length>2_000_000)req.destroy();});
          req.on('end',()=>{
            try {
              const data=JSON.parse(body);
              if(data.world!=='copper-metropolis'||!Array.isArray(data.rawFrameMs))throw new Error('Invalid benchmark');
              const name=`copper-web-${Date.now()}.json`;
              mkdirSync(resolve(project,'results'),{recursive:true});
              writeFileSync(resolve(project,'results',name),JSON.stringify(data,null,2));
              res.setHeader('Content-Type','application/json');res.end(JSON.stringify({file:name}));
            } catch {res.statusCode=400;res.end('Invalid result');}
          });return;
        }
        res.statusCode=404;res.end();
      });
    },
  }],
}));
