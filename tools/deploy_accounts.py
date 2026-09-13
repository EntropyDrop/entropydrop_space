#!/usr/bin/env python3
"""Publish the extracted account API image and roll existing ECS services through 19100."""
import argparse
import base64
import copy
import json
import shlex
import subprocess
from pathlib import Path
import deploy_domain as aws

BACKEND = aws.ROOT.parent / 'entropydrop_backend'
REGISTRY = '516909141967.dkr.ecr.us-east-2.amazonaws.com'
CLUSTER = 'ed-api-cluster'
SERVICES = ('ed-api-svc', 'ed-background-svc')

def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)

def ssh(args, **kwargs):
    return run(['ssh','ds@192.168.0.111','-o','BatchMode=yes',shlex.join([str(a) for a in args])],**kwargs)

def build():
    revision = run(['git','-C',BACKEND,'rev-parse','HEAD'],capture_output=True,text=True).stdout.strip()
    if run(['git','-C',BACKEND,'diff','HEAD','--name-only'],capture_output=True,text=True).stdout.strip():
        raise RuntimeError('Commit backend changes before production build')
    image = REGISTRY + '/entropydrop-api:space-domain-' + revision[:12]
    path = '/home/ds/.local/share/entropydrop-account-builds/' + revision
    ssh(['mkdir','-p',path])
    archive = run(['git','-C',BACKEND,'archive','--format=tar','HEAD'],capture_output=True).stdout
    ssh(['tar','-xf','-','-C',path],input=archive)
    ssh(['docker','build','--network','host','--build-arg','HTTP_PROXY='+aws.PROXY,
         '--build-arg','HTTPS_PROXY='+aws.PROXY,'--build-arg','http_proxy='+aws.PROXY,
         '--build-arg','https_proxy='+aws.PROXY,'--label','org.opencontainers.image.revision='+revision,
         '-t',image,path])
    auth = aws.client('ecr','us-east-2').get_authorization_token()['authorizationData'][0]
    _, password = base64.b64decode(auth['authorizationToken']).decode().split(':',1)
    ssh(['docker','login','--username','AWS','--password-stdin',REGISTRY],input=password.encode(),stdout=subprocess.DEVNULL)
    ssh(['docker','push',image])
    aws.save('account-image.json',{'image':image,'commit':revision})
    print('Published',image,flush=True)

def rollout():
    image = json.loads((aws.STATE/'account-image.json').read_text())['image']
    ecs=aws.client('ecs','us-east-2')
    allowed=set(ecs.meta.service_model.operation_model('RegisterTaskDefinition').input_shape.members)
    for name in SERVICES:
        service=ecs.describe_services(cluster=CLUSTER,services=[name])['services'][0]
        old=ecs.describe_task_definition(taskDefinition=service['taskDefinition'])['taskDefinition']
        aws.save(name+'-rollback.json',{'service':service,'task':old})
        new={k:copy.deepcopy(v) for k,v in old.items() if k in allowed}
        for container in new['containerDefinitions']:
            container['image']=image
            env={e['name']:e['value'] for e in container.get('environment',[])}
            origins=[v.strip() for v in env.get('CORS_ORIGINS','https://entropydrop.com,https://www.entropydrop.com,http://localhost:5173,http://localhost:3000').split(',') if v.strip()]
            if 'https://space.entropydrop.com' not in origins: origins.append('https://space.entropydrop.com')
            env['CORS_ORIGINS']=','.join(origins)
            env['SPACE_PUBLIC_API_URL']='https://space.entropydrop.com'
            container['environment']=[{'name':k,'value':v} for k,v in env.items()]
        registered=ecs.register_task_definition(**new)['taskDefinition']['taskDefinitionArn']
        ecs.update_service(cluster=CLUSTER,service=name,taskDefinition=registered)
        print(name,'rolling out',registered,flush=True)

def status():
    ecs=aws.client('ecs','us-east-2')
    for service in ecs.describe_services(cluster=CLUSTER,services=list(SERVICES))['services']:
        print(json.dumps({'name':service['serviceName'],'desired':service['desiredCount'],'running':service['runningCount'],
            'deployments':[{'task':d['taskDefinition'],'running':d['runningCount'],'pending':d['pendingCount'],'state':d.get('rolloutState')} for d in service['deployments']]}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['build','rollout','status']);args=parser.parse_args()
    aws.initialize();globals()[args.action]()
