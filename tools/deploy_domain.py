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
from fnmatch import fnmatchcase
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
import boto3
from botocore.config import Config
from dotenv import dotenv_values
from release_static import (HTML_CACHE, MAIN_ROUTES, LEGACY_ROUTES, manifest,
                            release_lock, snapshot_build, verify_online, wait_for_cdn, write_json)

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
    write_json(STATE / name, value)


def new_run(kind):
    directory = STATE / 'releases' / f'{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}-{kind}-{uuid4().hex[:8]}'
    directory.mkdir(parents=True, mode=0o700)
    return directory

def distribution():
    for page in client('cloudfront').get_paginator('list_distributions').paginate():
        for item in page.get('DistributionList', {}).get('Items', []):
            if HOST in item.get('Aliases', {}).get('Items', []):
                return item
    return None

def publish_function(name, code, comment, backup_dir=None):
    cf = client('cloudfront')
    try:
        old = cf.describe_function(Name=name)
        if backup_dir:
            prior = cf.get_function(Name=name, Stage='LIVE')['FunctionCode'].read()
            path = backup_dir / (name + '.js')
            path.write_bytes(prior); path.chmod(0o600)
        # Snapshot deployed behavior before edits; do not print function code.
        if not (STATE / (name + '.js')).exists():
            prior = cf.get_function(Name=name, Stage='LIVE')['FunctionCode'].read()
            path = STATE / (name + '.js'); path.write_bytes(prior); path.chmod(0o600)
        result = cf.update_function(Name=name, IfMatch=old['ETag'], FunctionConfig={'Comment': comment, 'Runtime': 'cloudfront-js-2.0'}, FunctionCode=code.encode())
    except cf.exceptions.NoSuchFunctionExists:
        result = cf.create_function(Name=name, FunctionConfig={'Comment': comment, 'Runtime': 'cloudfront-js-2.0'}, FunctionCode=code.encode())
    return cf.publish_function(Name=name, IfMatch=result['ETag'])['FunctionSummary']['FunctionMetadata']['FunctionARN']

def prepare(release, timeout=900):
    if not release or any(c not in '0123456789abcdefghijklmnopqrstuvwxyz-_' for c in release):
        raise ValueError('Use a literal release identifier')
    cf = client('cloudfront')
    build = ROOT / 'client/dist'
    validate_production_build(build)
    run_dir = new_run('space')
    build, _files = snapshot_build(build, run_dir)
    existing = distribution()
    previous = cf.get_distribution_config(Id=existing['Id']) if existing else None
    prefix = 'space-app/' + release + '/'
    if previous:
        old_origin = next(o for o in previous['DistributionConfig']['Origins']['Items'] if o['Id'] == 'space-static')
        if old_origin['OriginPath'] == '/' + prefix.rstrip('/'):
            raise RuntimeError('Release is already active; use verify-space or a new release identifier.')
        retain_assets(old_origin['OriginPath'].lstrip('/') + '/', prefix)
    # Stage and verify every object before changing the live origin.
    upload(build, prefix, backup_dir=run_dir, immutable=True)
    verify_objects(build, prefix)
    if previous:
        write_json(run_dir / 'distribution-before.json', previous)
        config = copy.deepcopy(previous['DistributionConfig'])
        next(o for o in config['Origins']['Items'] if o['Id'] == 'space-static')['OriginPath'] = '/' + prefix.rstrip('/')
        # Preserve gateway paths, security settings and every unrelated behavior.
        result = cf.update_distribution(Id=existing['Id'], IfMatch=previous['ETag'], DistributionConfig=config)['Distribution']
        finish_space_release(result, release, build, run_dir, timeout)
        return
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
        'Origins': {'Quantity': 2, 'Items': [origin, api_origin]}, 'OriginGroups': {'Quantity': 0}, 'DefaultCacheBehavior': static,
        'CacheBehaviors': {'Quantity': len(behaviors), 'Items': behaviors}, 'ViewerCertificate': main['ViewerCertificate'],
        'CustomErrorResponses': {'Quantity': 5, 'Items': [{'ErrorCode': c, 'ResponsePagePath': '', 'ResponseCode': '', 'ErrorCachingMinTTL': 0} for c in [400,403,404,500,503]]},
        'Logging': {'Enabled': False, 'IncludeCookies': False, 'Bucket': '', 'Prefix': ''},
        'Restrictions': {'GeoRestriction': {'RestrictionType': 'none', 'Quantity': 0}},
        'WebACLId': ''}
    result = cf.create_distribution(DistributionConfig=config)['Distribution']
    s3 = client('s3', 'us-east-2')
    policy = json.loads(s3.get_bucket_policy(Bucket=BUCKET)['Policy'])
    if not (STATE / 'bucket-policy-before.json').exists(): save('bucket-policy-before.json', policy)
    statement = {'Sid': 'AllowSpaceAppCloudFront', 'Effect': 'Allow', 'Principal': {'Service': 'cloudfront.amazonaws.com'},
        'Action': 's3:GetObject', 'Resource': f'arn:aws:s3:::{BUCKET}/space-app/*',
        'Condition': {'StringEquals': {'AWS:SourceArn': result['ARN']}}}
    policy['Statement'] = [p for p in policy['Statement'] if p.get('Sid') != statement['Sid']] + [statement]
    s3.put_bucket_policy(Bucket=BUCKET, Policy=json.dumps(policy))
    finish_space_release(result, release, build, run_dir, timeout, verify_public=False)

def upload(directory, prefix, *, aliases=(), backup_dir=None, immutable=False):
    s3 = client('s3', 'us-east-2'); directory = Path(directory)
    manifest(directory, main=bool(aliases))
    files = [p for p in directory.rglob('*') if p.is_file()]
    existing = {o['Key']: o['ETag'].strip('"') for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=prefix) for o in page.get('Contents', [])}
    entries = [(prefix + path.relative_to(directory).as_posix(), path) for path in files]
    entries += [(prefix + route, directory / route / 'index.html') for route in aliases]
    planned = []
    rollback = []
    # Preflight all collisions and save old HTML before making any writes.
    for key, path in entries:
        body = path.read_bytes()
        is_html = path.suffix == '.html'
        old = None
        if key in existing and (is_html or existing[key] != hashlib.md5(body).hexdigest()):
            old = s3.get_object(Bucket=BUCKET, Key=key)
            old_body = old['Body'].read()
            if old['ETag'].strip('"') != existing[key]:
                raise RuntimeError(f'Object changed during release preflight: {key}')
            if old_body != body and (immutable or '/assets/' in '/' + key):
                raise RuntimeError(f'Immutable release object would be overwritten: {key}')
            if old_body == body and (not is_html or (old.get('ContentType') == 'text/html' and old.get('CacheControl') == HTML_CACHE)):
                continue
            if not backup_dir:
                backup_dir = new_run('objects')
            backup_name = hashlib.sha256(key.encode()).hexdigest() + '.body'
            with os.fdopen(os.open(backup_dir / backup_name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb') as output:
                output.write(old_body)
            rollback.append({'key': key, 'etag': old['ETag'], 'backup': backup_name,
                             'metadata': {k: old[k] for k in ('ContentType', 'CacheControl', 'ContentEncoding', 'Metadata') if k in old}})
        elif key in existing:
            continue
        planned.append((key, path, body, old))
    if backup_dir:
        write_json(backup_dir / 'objects-before.json', rollback)
        write_json(backup_dir / 'publication-plan.json', [
            {'key': key, 'sha256': hashlib.sha256(body).hexdigest(),
             'previous_etag': old['ETag'] if old else None, 'html': path.suffix == '.html'}
            for key, path, body, old in planned
        ])

    def put(entry):
        key, path, body, old = entry
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        if path.suffix == '.wasm': content_type = 'application/wasm'
        cache = HTML_CACHE if path.suffix == '.html' else 'public, max-age=31536000, immutable' if '/assets/' in '/' + key else 'public, max-age=86400'
        condition = {'IfMatch': old['ETag']} if old else {'IfNoneMatch': '*'}
        s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=content_type, CacheControl=cache, **condition)
        return 1
    assets = [entry for entry in planned if entry[1].suffix != '.html']
    html = [entry for entry in planned if entry[1].suffix == '.html']
    with ThreadPoolExecutor(max_workers=8) as pool: count = sum(pool.map(put, assets))
    count += sum(put(p) for p in html)
    print(f'Uploaded {count} changed objects through 19100; HTML published last; no objects deleted.')


def retain_assets(old_prefix, prefix):
    if not old_prefix.startswith('space-app/') or not prefix.startswith('space-app/'):
        raise RuntimeError('Expected isolated Space release prefixes')
    s3 = client('s3', 'us-east-2')
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=old_prefix + 'assets/'):
        for item in page.get('Contents', []):
            old = s3.get_object(Bucket=BUCKET, Key=item['Key'])
            body = old['Body'].read()
            key = prefix + item['Key'][len(old_prefix):]
            # Existing retry targets must contain the same immutable bytes.
            try:
                current = s3.get_object(Bucket=BUCKET, Key=key)
            except s3.exceptions.NoSuchKey:
                metadata = {k: old[k] for k in ('ContentType', 'CacheControl', 'ContentEncoding') if k in old}
                s3.put_object(Bucket=BUCKET, Key=key, Body=body, IfNoneMatch='*', **metadata)
            else:
                if current['Body'].read() != body:
                    raise RuntimeError(f'Conflicting retained asset: {key}')


def verify_objects(directory, prefix, aliases=()):
    s3 = client('s3', 'us-east-2')
    expected = manifest(directory, main=bool(aliases))
    expected.update({route: expected[route + '/index.html'] for route in aliases})
    def check(item):
        name, digest = item
        actual = s3.get_object(Bucket=BUCKET, Key=prefix + name)
        if hashlib.sha256(actual['Body'].read()).hexdigest() != digest:
            raise RuntimeError(f'Staged object differs from build: {prefix + name}')
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(check, expected.items()))


def invalidate(cf, distribution_id):
    return cf.create_invalidation(DistributionId=distribution_id, InvalidationBatch={
        'Paths': {'Quantity': 1, 'Items': ['/*']}, 'CallerReference': str(time.time_ns()),
    })['Invalidation']['Id']


def finish_space_release(result, release, build, run_dir, timeout, verify_public=True):
    state = {'release': release, 'id': result['Id'], 'domain': result['DomainName'],
             'phase': 'propagating', 'run_dir': str(run_dir)}
    save('release.json', state)
    cf = client('cloudfront')
    invalidation = invalidate(cf, result['Id'])
    write_json(run_dir / 'activation.json', {**state, 'invalidation': invalidation})
    print('Waiting for Space CDN deployment and invalidation.', flush=True)
    wait_for_cdn(cf, result['Id'], invalidation, timeout=timeout)
    if verify_public:
        report = verify_online(build, 'https://' + HOST, PROXY)
        write_json(run_dir / 'verification.json', report)
        state['phase'] = 'verified'
    else:
        state['phase'] = 'awaiting-dns'
    save('release.json', state)
    print(json.dumps(state), flush=True)

def validate_production_build(directory):
    directory = Path(directory)
    files = [path for path in directory.rglob('*') if path.is_file() and path.suffix in ('.html', '.js')]
    if not files:
        raise RuntimeError(f'Production build is empty: {directory}')
    values = dotenv_values(ROOT.parent / 'entropydrop_backend/.env.prod')
    google_client_id = (values.get('GOOGLE_CLIENT_ID') or '').strip()
    required = [google_client_id, 'https://api.entropydrop.com']
    if not google_client_id.endswith('.apps.googleusercontent.com'):
        raise RuntimeError('Production GOOGLE_CLIENT_ID is missing or invalid')
    bodies = [path.read_bytes() for path in files]
    missing = [value for value in required if not any(value.encode() in body for body in bodies)]
    if missing:
        raise RuntimeError('Production build is missing explicit account configuration: ' + ', '.join(missing))

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

def main_router_source():
    return '''function handler(event) {
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
    var pages = MAIN_ROUTE_PATHS;
    if (pages.indexOf(uri) >= 0) request.uri = uri + '/index.html';
    else if (uri.endsWith('/')) request.uri += 'index.html';
    return request;
}'''.replace('MAIN_ROUTE_PATHS', json.dumps(['/' + route for route in MAIN_ROUTES]))


def require_main_router():
    cf = client('cloudfront')
    config = cf.get_distribution_config(Id=MAIN_DISTRIBUTION)['DistributionConfig']
    behaviors = config.get('CacheBehaviors', {}).get('Items', [])
    paths = [path for route in MAIN_ROUTES for path in ('/' + route, '/' + route + '/', '/' + route + '/index.html')]
    paths.extend(LEGACY_ROUTES)
    for path in paths:
        behavior = next((b for b in behaviors if fnmatchcase(path.lstrip('/'), b['PathPattern'].lstrip('/'))), config['DefaultCacheBehavior'])
        functions = behavior.get('FunctionAssociations', {}).get('Items', [])
        if not any(f['EventType'] == 'viewer-request' and f['FunctionARN'].endswith(':function/entropydrop-frontend-router') for f in functions):
            raise RuntimeError(f'Main-site route bypasses the managed viewer-request router: {path}')
    return config


def redirect_main(backup_dir=None):
    require_main_router()
    publish_function('entropydrop-frontend-router', main_router_source(),
                     'Main-site routes and legacy Space entry redirect', backup_dir=backup_dir)
    print('Published legacy Space redirect.')


def upload_main(timeout=900):
    source = ROOT.parent / 'entropydrop_frontend/dist'
    validate_production_build(source)
    config = require_main_router()
    run_dir = new_run('main')
    build, _files = snapshot_build(source, run_dir, main=True)
    write_json(run_dir / 'distribution-before.json', config)
    upload(build, '', aliases=MAIN_ROUTES, backup_dir=run_dir)
    verify_objects(build, '', MAIN_ROUTES)
    redirect_main(backup_dir=run_dir)
    cf = client('cloudfront')
    invalidation = invalidate(cf, MAIN_DISTRIBUTION)
    write_json(run_dir / 'activation.json', {'invalidation': invalidation, 'phase': 'propagating'})
    print('Waiting for main-site CDN deployment and invalidation.', flush=True)
    wait_for_cdn(cf, MAIN_DISTRIBUTION, invalidation, timeout=timeout)
    report = verify_online(build, 'https://entropydrop.com', PROXY, main=True)
    write_json(run_dir / 'verification.json', report)
    print(f'Main-site release verified: {run_dir}', flush=True)


def verify_site(main_site=False):
    cf = client('cloudfront')
    if main_site:
        require_main_router()
        source = ROOT.parent / 'entropydrop_frontend/dist'
        origin, distribution_id = 'https://entropydrop.com', MAIN_DISTRIBUTION
    else:
        state = json.loads((STATE / 'release.json').read_text())
        source = ROOT / 'client/dist'
        origin, distribution_id = 'https://' + HOST, state['id']
        config = cf.get_distribution_config(Id=distribution_id)['DistributionConfig']
        active = next(o for o in config['Origins']['Items'] if o['Id'] == 'space-static')['OriginPath']
        if active != '/space-app/' + state['release']:
            raise RuntimeError('Live Space origin does not match the recorded release.')
    validate_production_build(source)
    if cf.get_distribution(Id=distribution_id)['Distribution']['Status'] != 'Deployed':
        raise RuntimeError('CloudFront is still deploying; release is not verified.')
    report = verify_online(source, origin, PROXY, main=main_site)
    save(('main' if main_site else 'space') + '-verification.json', report)
    print(json.dumps(report), flush=True)
    return report


def upload_space():
    state = json.loads((STATE / 'release.json').read_text())
    validate_production_build(ROOT / 'client/dist')
    # prepare stages before activation. Never overwrite an active release.
    verify_objects(ROOT / 'client/dist', 'space-app/' + state['release'] + '/')
    return verify_site()

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare','upload-space','upload-main','activate','redirect-main','status','verify-main','verify-space'])
    parser.add_argument('--release')
    parser.add_argument('--timeout', type=int, default=900, help='CDN propagation timeout in seconds (default: 900).')
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    initialize()
    if args.action in ('verify-main', 'verify-space'):
        verify_site(args.action == 'verify-main')
        return
    if args.action == 'status':
        d = distribution(); print(json.dumps({'id': d['Id'], 'status': d['Status'], 'domain': d['DomainName']} if d else {'exists':False}))
        return
    with release_lock(STATE):
        if args.action == 'prepare': prepare(args.release, args.timeout)
        elif args.action == 'upload-space': upload_space()
        elif args.action == 'upload-main': upload_main(args.timeout)
        elif args.action == 'activate': activate()
        elif args.action == 'redirect-main':
            redirect_main(backup_dir=new_run('router'))
            invalidation = invalidate(client('cloudfront'), MAIN_DISTRIBUTION)
            wait_for_cdn(client('cloudfront'), MAIN_DISTRIBUTION, invalidation, timeout=args.timeout)
            verify_site(True)

if __name__ == '__main__': main()
