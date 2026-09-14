#!/usr/bin/env python3
"""Private-address development DNS and least-privilege DNS-01 renewal credentials."""
import json,os,subprocess
import deploy_domain as aws
HOST='space-dev-908123.entropydrop.com'
USER='entropydrop-space-dev-certbot'
STATE=aws.ROOT/'.local/dev-domain'

def main():
 aws.initialize();STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
 r53=aws.client('route53')
 zone=next(z for page in r53.get_paginator('list_hosted_zones').paginate() for z in page['HostedZones'] if z['Name']=='entropydrop.com.' and not z['Config']['PrivateZone'])
 iam=aws.client('iam')
 try: iam.get_user(UserName=USER)
 except iam.exceptions.NoSuchEntityException: iam.create_user(UserName=USER,Tags=[{'Key':'Purpose','Value':'Space internal development DNS-01 TLS renewal'}])
 policy={'Version':'2012-10-17','Statement':[
  {'Effect':'Allow','Action':['route53:ListHostedZones','route53:ListHostedZonesByName'],'Resource':'*'},
  {'Effect':'Allow','Action':'route53:GetChange','Resource':'arn:aws:route53:::change/*'},
  {'Effect':'Allow','Action':'route53:ChangeResourceRecordSets','Resource':'arn:aws:route53:::'+zone['Id'].lstrip('/'),
   'Condition':{'ForAllValues:StringEquals':{'route53:ChangeResourceRecordSetsNormalizedRecordNames':['_acme-challenge.'+HOST],'route53:ChangeResourceRecordSetsRecordTypes':['TXT'],'route53:ChangeResourceRecordSetsActions':['UPSERT','DELETE']}}}]}
 iam.put_user_policy(UserName=USER,PolicyName='OnlySpaceDevAcmeChallenge',PolicyDocument=json.dumps(policy))
 path=STATE/'aws-credentials'
 if not path.exists():
  if iam.list_access_keys(UserName=USER)['AccessKeyMetadata']: raise RuntimeError('Existing renewal key must be restored; refusing rotation')
  key=iam.create_access_key(UserName=USER)['AccessKey']
  with os.fdopen(os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600),'w') as f:
   f.write('[default]\naws_access_key_id='+key['AccessKeyId']+'\naws_secret_access_key='+key['SecretAccessKey']+'\n')
 previous=r53.list_resource_record_sets(HostedZoneId=zone['Id'],StartRecordName=HOST,MaxItems='5')['ResourceRecordSets']
 prior=[r for r in previous if r['Name'].rstrip('.')==HOST]
 snapshot=STATE/'dns-before.json'
 if not snapshot.exists(): snapshot.write_text(json.dumps(prior));snapshot.chmod(0o600)
 if any(r['Type'] not in ('A',) for r in prior): raise RuntimeError('Unexpected existing DNS type; inspect before replacing')
 r53.change_resource_record_sets(HostedZoneId=zone['Id'],ChangeBatch={'Changes':[{'Action':'UPSERT','ResourceRecordSet':{'Name':HOST,'Type':'A','TTL':60,'ResourceRecords':[{'Value':'192.168.0.111'}]}}]})
 subprocess.run(['ssh','ds@192.168.0.111','-o','BatchMode=yes','install -d -m 700 /home/ds/.config/entropydrop-space-dev-domain'],check=True)
 subprocess.run(['scp',str(path),'ds@192.168.0.111:/home/ds/.config/entropydrop-space-dev-domain/aws-credentials'],check=True)
 print('Development DNS points only to 192.168.0.111; certificate credentials can change only its ACME TXT record.')

if __name__=='__main__':main()
