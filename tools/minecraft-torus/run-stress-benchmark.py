"""Run only the existing disposable torus fixture; archive complete captures."""
from pathlib import Path
import json, subprocess, shutil, time, hashlib, argparse, struct, zlib, gzip
parser=argparse.ArgumentParser()
parser.add_argument('--game', default='/tmp/space-torus-comparison')
parser.add_argument('--output', default='client/src/dev/results/torus-firefox-stress-2026-10-28/minecraft')
parser.add_argument('--terrains', nargs='+', default=['nature','copper-metropolis','aether-archipelago'])
args=parser.parse_args();root=Path.cwd();game=Path(args.game);out=Path(args.output)
assert game.name=='space-torus-comparison', 'Use the disposable fixture directory'
jar=root/'tools/minecraft-torus/build/libs/space-torus-benchmark-1.0.0.jar'
shutil.copy2(jar,game/'mods'/jar.name)
def complete_png(path):
 try:
  data=path.read_bytes();assert data[:8]==b'\x89PNG\r\n\x1a\n';at=8
  while at<len(data):
   size,kind=struct.unpack('>I4s',data[at:at+8]);payload=data[at+8:at+8+size]
   assert zlib.crc32(kind+payload)==struct.unpack('>I',data[at+8+size:at+12+size])[0]
   if kind==b'IEND':return True
   at+=size+12
 except (OSError,AssertionError,struct.error):pass
 return False
for name in args.terrains:
 dest=out/name;dest.mkdir(parents=True,exist_ok=True)
 assert not (dest/'torus-stress-minecraft.json.gz').exists(), 'Do not overwrite accepted evidence'
 for filename in ['torus-stress-status.json','torus-stress-minecraft.json']:
  path=game/filename
  if path.exists():path.rename(game/(filename+'.previous'))
 for path in (game/'screenshots').glob('stress-*.png'):path.unlink()
 shutil.copy2(root/'client/src/dev/results/torus-minecraft-2026-10-27/minecraft'/name/'torus-validation.json',game/'torus-validation.json')
 command=json.loads((game/(name+'-launch-args.json')).read_text())
 command=[a for a in command if not a.startswith(('-Dspace_torus.reuseValidation=', '-Dspace_torus.refreshMissing=', '-Dspace_torus.fixedDetail=', '-Dspace_torus.order=', '-Dspace_torus.stress='))]
 i=command.index('net.fabricmc.loader.impl.launch.knot.KnotClient')
 command[i:i]=['-Dspace_torus.reuseValidation=true','-Dspace_torus.fixedDetail=true','-Dspace_torus.stress=true']
 with open(game/'launch.log','w') as log:
  process=subprocess.Popen(command,cwd=game,stdout=log,stderr=log,start_new_session=True)
  (game/'benchmark.pid').write_text(str(process.pid));print(name,'PID',process.pid,flush=True)
  try:
   deadline=time.monotonic()+900;last=None
   while time.monotonic()<deadline:
    time.sleep(5)
    if process.poll() is not None:raise RuntimeError('Minecraft exited')
    try:status=json.loads((game/'torus-stress-status.json').read_text())
    except (OSError,json.JSONDecodeError):continue
    current=(status['state'],status.get('fixedSections'),status.get('fixedPending'))
    if current!=last:print(name,status,flush=True);last=current
    if status['state'].startswith('FAILED'):raise RuntimeError(status)
    if status['state']=='complete':break
   else:raise RuntimeError('Timed out')
   captures=[game/'screenshots'/f'stress-{i}-{mode}.png' for i,mode in enumerate(['control','dense','turn','move','move','turn','dense','control'])]
   deadline=time.monotonic()+30
   while not all(complete_png(p) for p in captures):
    if time.monotonic()>deadline:raise RuntimeError('Incomplete screenshot')
    time.sleep(.25)
   (dest/'torus-stress-minecraft.json.gz').write_bytes(gzip.compress((game/'torus-stress-minecraft.json').read_bytes(),mtime=0))
   shutil.copy2(game/'torus-validation.json',dest/'torus-validation.json')
   for path in captures:shutil.copy2(path,dest/path.name)
   (dest/'build-sha256.txt').write_text(hashlib.sha256(jar.read_bytes()).hexdigest())
  finally:
   process.terminate()
   try:process.wait(timeout=25)
   except subprocess.TimeoutExpired:process.kill();process.wait()
   (dest/'launch.log.gz').write_bytes(gzip.compress((game/'launch.log').read_bytes(),mtime=0))
 print(name,'saved',flush=True)
 time.sleep(4)
