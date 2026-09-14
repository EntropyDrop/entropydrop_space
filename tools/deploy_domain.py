#!/usr/bin/env python3
"""Publish Space to its dedicated CloudFront host; every AWS call uses the 19100 proxy."""
import argparse
import copy
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import time
from concurrent.futures import ThreadPoolExecutor
import boto3
from botocore.config import Config
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.local/domain-migration'
HOST = 'space.entropydrop.com'
BUCKET = 'entropydrop-com-frontend'
MAIN_DISTRIBUTION = 'E1EYC8VR1RCTFX'
API_DISTRIBUTION = 'E1Y004OSRWPKO6'
PROXY = 'http://127.0.0.1:19100'
CONFIG = Config(proxies={'http': PROXY, 'https': PROXY}, connect_timeout=10, read_timeout=60, max_pool_connections=16)

def initialize():
    values = dotenv_values(ROOT.parent / 'entropydrop_backend/.env.prod')
    for key in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'):
        if values.get(key):
            os.environ[key] = values[key]
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)

def client(service, region='us-east-1'):
    return boto3.client(service, region_name=region, config=CONFIG)

def save(name, value):
    path = STATE / name
    with os.fdopen(os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), 'w') as output:
        json.dump(value, output, indent=2, default=str)

def distribution():
    for page in client('cloudfront').get_paginator('list_distributions').paginate():
        for item in page.get('DistributionList', {}).get('Items', []):
            if HOST in item.get('Aliases', {}).get('Items', []):
                return item
    return None

def publish_function(name, code, comment):
    cf = client('cloudfront')
    try:
        old = cf.describe_function(Name=name)
        # Snapshot deployed behavior before edits; do not print function code.
        if not (STATE / (name + '.js')).exists():
            prior = cf.get_function(Name=name, Stage='LIVE')['FunctionCode'].read()
            path = STATE / (name + '.js'); path.write_bytes(prior); path.chmod(0o600)
        result = cf.update_function(Name=name, IfMatch=old['ETag'], FunctionConfig={'Comment': comment, 'Runtime': 'cloudfront-js-2.0'}, FunctionCode=code.encode())
    except cf.exceptions.NoSuchFunctionExists:
        result = cf.create_function(Name=name, FunctionConfig={'Comment': comment, 'Runtime': 'cloudfront-js-2.0'}, FunctionCode=code.encode())
    return cf.publish_function(Name=name, IfMatch=result['ETag'])['FunctionSummary']['FunctionMetadata']['FunctionARN']

def prepare(release):
    if not release or any(c not in '0123456789abcdefghijklmnopqrstuvwxyz-_' for c in release):
        raise ValueError('Use a literal release identifier')
    cf = client('cloudfront')
    api = cf.get_distribution_config(Id=API_DISTRIBUTION)['DistributionConfig']
    main = cf.get_distribution_config(Id=MAIN_DISTRIBUTION)['DistributionConfig']
    router = publish_function('entropydrop-space-app-router', '''function handler(event) {
    var request = event.request;
    if (request.uri === '/' || request.uri === '/index.html') request.uri = '/index.html';
    return request;
}''', 'Space standalone static entry')
    origin = copy.deepcopy(main['Origins']['Items'][0])
    origin['Id'] = 'space-static'
    origin['OriginPath'] = '/space-app/' + release
    api_origin = copy.deepcopy(api['Origins']['Items'][0])
    static = copy.deepcopy(main['DefaultCacheBehavior'])
    static.update(TargetOriginId='space-static', CachePolicyId='4135ea2d-6df8-44a3-9df3-4b5a84be39ad', FunctionAssociations={'Quantity': 1, 'Items': [{'FunctionARN': router, 'EventType': 'viewer-request'}]})
    paths = ['/space/api/*', '/space/ws/*', '/space/objects/*', '/space/agent/*', '/space/health', '/space/ready']
    behaviors = []
    for path in paths:
        behavior = copy.deepcopy(api['DefaultCacheBehavior']); behavior['PathPattern'] = path; behaviors.append(behavior)
    asset = copy.deepcopy(static)
    asset.update(PathPattern='/assets/*', CachePolicyId='658327ea-f89d-4fab-a63d-7e88639e58f6', FunctionAssociations={'Quantity': 0})
    behaviors.append(asset)
    config = {'CallerReference': 'space-app-' + str(time.time_ns()), 'Comment': 'Standalone Space client and API', 'Aliases': {'Quantity': 1, 'Items': [HOST]},
        'Enabled': True, 'IsIPV6Enabled': True, 'HttpVersion': 'http2and3', 'PriceClass': 'PriceClass_All', 'DefaultRootObject': 'index.html',
        'Origins': {'Quantity': 2, 'Items': [origin, api_origin]}, 'DefaultCacheBehavior': static,
        'CacheBehaviors': {'Quantity': len(behaviors), 'Items': behaviors}, 'ViewerCertificate': main['ViewerCertificate'],
        'CustomErrorResponses': {'Quantity': 5, 'Items': [{'ErrorCode': c, 'ErrorCachingMinTTL': 0} for c in [400,403,404,500,503]]}}
    existing = distribution()
    if existing:
        previous = cf.get_distribution_config(Id=existing['Id'])
        save('space-distribution-before.json', previous)
        config['CallerReference'] = previous['DistributionConfig']['CallerReference']
        result = cf.update_distribution(Id=existing['Id'], IfMatch=previous['ETag'], DistributionConfig=config)['Distribution']
    else:
        result = cf.create_distribution(DistributionConfig=config)['Distribution']
    s3 = client('s3', 'us-east-2')
    policy = json.loads(s3.get_bucket_policy(Bucket=BUCKET)['Policy'])
    if not (STATE / 'bucket-policy-before.json').exists(): save('bucket-policy-before.json', policy)
    statement = {'Sid': 'AllowSpaceAppCloudFront', 'Effect': 'Allow', 'Principal': {'Service': 'cloudfront.amazonaws.com'},
        'Action': 's3:GetObject', 'Resource': f'arn:aws:s3:::{BUCKET}/space-app/*',
        'Condition': {'StringEquals': {'AWS:SourceArn': result['ARN']}}}
    policy['Statement'] = [p for p in policy['Statement'] if p.get('Sid') != statement['Sid']] + [statement]
    s3.put_bucket_policy(Bucket=BUCKET, Policy=json.dumps(policy))
    save('release.json', {'release': release, 'id': result['Id'], 'domain': result['DomainName']})
    print(json.dumps({'id': result['Id'], 'domain': result['DomainName'], 'release': release, 'dns': 'not changed'}))

def upload(directory, prefix):
    s3 = client('s3', 'us-east-2'); directory = Path(directory)
    if not (directory / 'index.html').is_file(): raise RuntimeError('Build output is missing index.html')
    files = [p for p in directory.rglob('*') if p.is_file()]
    existing = {o['Key']: o['ETag'].strip('"') for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=prefix) for o in page.get('Contents', [])}
    def put(path):
        key = prefix + path.relative_to(directory).as_posix()
        body = path.read_bytes()
        if existing.get(key) == hashlib.md5(body).hexdigest(): return 0
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        if path.suffix == '.wasm': content_type = 'application/wasm'
        cache = 'no-cache, no-store, must-revalidate' if path.suffix == '.html' else 'public, max-age=31536000, immutable' if '/assets/' in '/' + key else 'public, max-age=86400'
        s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=content_type, CacheControl=cache)
        return 1
    assets = [p for p in files if p.suffix != '.html']; html = [p for p in files if p.suffix == '.html']
    with ThreadPoolExecutor(max_workers=8) as pool: count = sum(pool.map(put, assets))
    count += sum(put(p) for p in html)
    print(f'Uploaded {count} changed objects through 19100; HTML published last; no objects deleted.')

def activate():
    current = json.loads((STATE / 'release.json').read_text())
    cf = client('cloudfront')
    if cf.get_distribution(Id=current['id'])['Distribution']['Status'] != 'Deployed':
        raise RuntimeError('CloudFront is still deploying; check status before activation')
    r53 = client('route53')
    zone = next(z for page in r53.get_paginator('list_hosted_zones').paginate() for z in page['HostedZones'] if z['Name'] == 'entropydrop.com.' and not z['Config']['PrivateZone'])
    if not (STATE / 'dns-before.json').exists():
        records = r53.list_resource_record_sets(HostedZoneId=zone['Id'], StartRecordName=HOST, MaxItems='10')['ResourceRecordSets']
        save('dns-before.json', [r for r in records if r['Name'].rstrip('.') == HOST])
    response = r53.change_resource_record_sets(HostedZoneId=zone['Id'], ChangeBatch={'Changes': [{'Action': 'UPSERT', 'ResourceRecordSet': {'Name': HOST, 'Type': kind, 'AliasTarget': {'HostedZoneId': 'Z2FDTNDATAQYW2', 'DNSName': current['domain'], 'EvaluateTargetHealth': False}}} for kind in ['A','AAAA']]})
    print('Space DNS activation:', response['ChangeInfo']['Id'])

def redirect_main():
    publish_function('entropydrop-frontend-router', '''function handler(event) {
    var request = event.request;
    var uri = request.uri;
    if (uri === '/space/app' || uri.indexOf('/space/app/') === 0) {
        var parts = [];
        for (var key in request.querystring) {
            var item = request.querystring[key];
            var values = item.multiValue || [item];
            for (var i = 0; i < values.length; i++) parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(values[i].value));
        }
        var destination = 'https://space.entropydrop.com/' + (parts.length ? '?' + parts.join('&') : '');
        return {statusCode: 302, statusDescription: 'Found', headers: {location: {value: 'https://entropydrop.com/space/login?destination=' + encodeURIComponent(destination)}, 'cache-control': {value: 'no-store'}}};
    }
    if (uri === '/space/login') request.uri = '/space/login/index.html';
    else if (uri.endsWith('/')) request.uri += 'index.html';
    return request;
}''', 'Main-site routes and legacy Space entry redirect')
    print('Published legacy Space redirect.')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare','upload-space','upload-main','activate','redirect-main','status'])
    parser.add_argument('--release')
    args = parser.parse_args(); initialize()
    if args.action == 'prepare': prepare(args.release)
    elif args.action == 'upload-space':
        state = json.loads((STATE / 'release.json').read_text())
        upload(ROOT / 'client/dist', 'space-app/' + state['release'] + '/')
        result = client('cloudfront').create_invalidation(
            DistributionId=state['id'],
            InvalidationBatch={'Paths': {'Quantity': 1, 'Items': ['/*']}, 'CallerReference': str(time.time_ns())}
        )
        print('Space invalidation:', result['Invalidation']['Id'])
    elif args.action == 'upload-main':
        upload(ROOT.parent / 'entropydrop_frontend/dist', '')
        result = client('cloudfront').create_invalidation(DistributionId=MAIN_DISTRIBUTION, InvalidationBatch={'Paths': {'Quantity': 1, 'Items': ['/*']}, 'CallerReference': str(time.time_ns())})
        print('Main invalidation:', result['Invalidation']['Id'])
    elif args.action == 'activate': activate()
    elif args.action == 'redirect-main': redirect_main()
    else:
        d = distribution(); print(json.dumps({'id': d['Id'], 'status': d['Status'], 'domain': d['DomainName']} if d else {'exists':False}))

if __name__ == '__main__': main()
