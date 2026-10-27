import { createServer } from 'node:http';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const root = resolve(process.argv[2]);
createServer(async (req, res) => {
  if(req.headers.host !== '127.0.0.1:54380' || req.headers.origin !== 'http://localhost:5173'){res.writeHead(403).end();return;}
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);res.setHeader('Cache-Control','no-store');
  if(req.method === 'OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST');res.writeHead(204).end();return;}
  if(req.method !== 'POST' || !/^\/(?:status\.json|result\.json|(?:near|wide|flat|restored|view-[0-4]-(?:wide|flat|restored))\.png)$/.test(req.url ?? '')){res.writeHead(400).end();return;}
  try{let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>64*1024*1024)throw Error('too large');chunks.push(c);}
    const path=resolve(root,'.'+req.url);await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',Buffer.concat(chunks));await rename(path+'.tmp',path);res.writeHead(204).end();
  }catch(e){res.writeHead(500).end(String(e));}
}).listen(54380,'127.0.0.1',()=>console.log(root));
