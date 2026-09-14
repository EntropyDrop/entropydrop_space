#!/usr/bin/env python3
"""Deploy prebuilt internal-development web assets and HTTPS gateway to DS."""
import datetime,io,json,shlex,subprocess,tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def ssh(command,**kwargs):
 return subprocess.run(['ssh','ds@192.168.0.111','-o','BatchMode=yes',shlex.join(command)],check=True,**kwargs)

def main():
 state=ROOT/'.local/dev-domain'
 files={}
 for kind in ('main','client'):
  base=state/kind
  if not (base/'index.html').exists():raise RuntimeError('Build both development applications first')
  for p in base.rglob('*'):
   if p.is_file():
    name=p.relative_to(base).as_posix()
    if kind=='main' and name=='index.html':name='main-index.html'
    if name.startswith('assets/') and name in files and files[name]!=p.read_bytes():raise RuntimeError('Asset collision')
    files[name]=p.read_bytes()
 release=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 target='/home/ds/.local/share/entropydrop-space-dev-web/releases/'+release
 ssh(['mkdir','-p',target])
 buffer=io.BytesIO()
 with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
  for name,body in files.items():
   info=tarfile.TarInfo(name);info.size=len(body);info.mode=0o644;archive.addfile(info,io.BytesIO(body))
 ssh(['tar','-xzf','-','-C',target],input=buffer.getvalue())
 config='/home/ds/.config/entropydrop-space-dev-domain'
 for name in ('nginx.conf','renew-tls.sh','entropydrop-space-dev-tls.service','entropydrop-space-dev-tls.timer'):
  subprocess.run(['scp',str(ROOT/'deploy/dev-domain'/name),'ds@192.168.0.111:'+config+'/'+name],check=True)
 script='''
import json,subprocess
from pathlib import Path
config=Path('/home/ds/.config/entropydrop-space-dev-domain')
data=Path('/home/ds/.local/share/entropydrop-space-dev-domain')
def run(args,**kwargs):return subprocess.run([str(a) for a in args],check=True,**kwargs)
(config/'certbot-image').write_text('certbot/dns-route53@sha256:38fdfaed25f1e2554b22b835d257756afcfe3acacb8f943ec0884c251e561130\\n')
(config/'renew-tls.sh').chmod(0o700)
run(['docker','pull','nginx:stable-alpine'])
image=run(['docker','image','inspect','--format','{{index .RepoDigests 0}}','nginx:stable-alpine'],capture_output=True,text=True).stdout.strip()
mounts=['--network','host','--read-only','--tmpfs','/var/cache/nginx','--tmpfs','/var/run','-v',str(config/'nginx.conf')+':/etc/nginx/nginx.conf:ro','-v',str(data/'letsencrypt')+':/etc/letsencrypt:ro','-v',TARGET+':/srv/web:ro']
run(['docker','run','--rm',*mounts,image,'nginx','-t'])
names=run(['docker','ps','-a','--format','{{.Names}}'],capture_output=True,text=True).stdout.splitlines()
name='entropydrop-space-dev-web'
if name in names:
 run(['docker','update','--restart=no',name]);run(['docker','stop',name]);run(['docker','rename',name,name+'-before-'+RELEASE])
run(['docker','run','-d','--name',name,'--restart','unless-stopped','--memory','128m','--cpus','1','--pids-limit','128',*mounts,image])
user=Path.home()/'.config/systemd/user';user.mkdir(parents=True,exist_ok=True)
for suffix in ('service','timer'):
 name='entropydrop-space-dev-tls.'+suffix;(user/name).write_bytes((config/name).read_bytes())
run(['systemctl','--user','daemon-reload']);run(['systemctl','--user','enable','--now','entropydrop-space-dev-tls.timer'])
run(['loginctl','show-user','ds','-p','Linger'])
(config/'web-release.json').write_text(json.dumps({'release':RELEASE,'path':TARGET,'image':image}))
'''
 ssh(['python3','-'],input=('TARGET='+repr(target)+'\nRELEASE='+repr(release)+'\n'+script).encode())
 print('Internal HTTPS development web deployed:',release)
if __name__=='__main__':main()
