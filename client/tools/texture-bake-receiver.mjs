/** Restricted local sink for reproducible DEV benchmark artifacts. */
import {createServer} from 'node:http';
import {mkdir, writeFile, rename} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
const root = resolve(process.argv[2] ?? 'client/src/dev/results/texture-bake-2026-11-05');
createServer(async (req,res) => {
  if (req.headers.host !== '127.0.0.1:54389' || !['http://localhost:5173','http://127.0.0.1:5173'].includes(req.headers.origin)) {res.writeHead(403);res.end();return;}
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.writeHead(204);res.end();return;}
  const match=/^\/(bake-\d+)\/((?:aether-archipelago|nature|copper-metropolis)(?:-[a-z0-9-]+)?\.(?:json|png)|failure\.txt|complete\.json)$/.exec(req.url??'');
  if(req.method!=='POST'||!match){res.writeHead(400);res.end();return;}
  try{const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>32*1024*1024)throw Error('Too large');chunks.push(c);}
    const path=resolve(root,match[1],match[2]);await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',Buffer.concat(chunks));await rename(path+'.tmp',path);res.writeHead(204);res.end();
  }catch(e){res.writeHead(500);res.end(String(e));}
}).listen(54389,'127.0.0.1',()=>console.log(`Texture experiment receiver: ${root}`));
