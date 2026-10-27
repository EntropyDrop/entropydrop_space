"""Generate one-pixel, opaque albedo textures; no external game assets."""
from pathlib import Path
import json,struct,zlib
root=Path(__file__).parent/'build/generated/resources'
def hash32(x,y,z,seed):
 h=((x*0x1f123bb5)^(y*0x5f356495)^(z*0x6c8e9cf5)^seed)&0xffffffff
 h=((h^(h>>16))*0x7feb352d)&0xffffffff
 h=((h^(h>>15))*0x846ca68b)&0xffffffff
 return h^(h>>16)
def chunk(kind,data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
def write(path,data):
 p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data if isinstance(data,bytes) else (json.dumps(data)+'\n').encode())
for i in range(256):
 rgb=0x404040+(hash32(i,0,0,0x31415926)&0x7f7f7f)
 pixel=bytes([0,rgb>>16,(rgb>>8)&255,rgb&255])
 png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixel))+chunk(b'IEND',b'')
 write(Path(f'assets/spacebench/textures/block/color_{i}.png'),png)
 write(Path(f'assets/spacebench/models/block/color_{i}.json'),{'parent':'minecraft:block/cube_all','ambientocclusion':False,'textures':{'all':f'spacebench:block/color_{i}'}})
 write(Path(f'assets/spacebench/blockstates/color_{i}.json'),{'variants':{'':{'model':f'spacebench:block/color_{i}'}}})
print('Generated 256 opaque, one-pixel color blocks.')
