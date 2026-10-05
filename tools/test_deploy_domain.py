"""Verify Space static routing without accessing production services."""
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import deploy_domain as deploy
import release_static as static


def router_source():
    return deploy.main_router_source()


class SpaceStaticRouterTests(unittest.TestCase):
    def route(self, uri, query=None):
        script = "const vm=require('node:vm');const data=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(vm.runInNewContext(data.code+';handler(event)',{event:data.event})));"
        result = subprocess.run(['node', '-e', script, json.dumps({
            'code': router_source(), 'event': {'request': {'uri': uri, 'querystring': query or {}}},
        })], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    def test_extensionless_space_pages_use_current_generated_entries(self):
        for uri in ['/space', '/space/intro', '/space/apikeys', '/space/authorize', '/space/login', '/space/monitor', '/space/monitoring']:
            with self.subTest(uri=uri):
                self.assertEqual(self.route(uri)['uri'], uri + '/index.html')

    def test_trailing_slash_and_explicit_intro_match(self):
        self.assertEqual(self.route('/space/intro/')['uri'], '/space/intro/index.html')
        self.assertEqual(self.route('/space/intro/index.html')['uri'], '/space/intro/index.html')

    def test_assets_are_not_rewritten(self):
        self.assertEqual(self.route('/assets/example.js')['uri'], '/assets/example.js')

    def test_legacy_space_uses_main_login_and_preserves_repeated_query(self):
        from urllib.parse import parse_qs, urlparse
        for uri in ['/space/app', '/space/app/', '/space/app/index.html']:
            with self.subTest(uri=uri):
                result = self.route(uri, {'force_pc': {'value': '1'}, 'tag': {'multiValue': [{'value': 'a'}, {'value': 'b'}]}})
                self.assertEqual(result['statusCode'], 302)
                self.assertEqual(result['headers']['cache-control']['value'], 'no-store')
                login = urlparse(result['headers']['location']['value'])
                self.assertEqual(login.netloc, 'entropydrop.com')
                self.assertEqual(login.path, '/space/login')
                destination = urlparse(parse_qs(login.query)['destination'][0])
                self.assertEqual(destination.netloc, 'space.entropydrop.com')
                self.assertEqual(parse_qs(destination.query), {'force_pc': ['1'], 'tag': ['a', 'b']})


class FakeS3:
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def __init__(self):
        self.objects, self.writes = {}, []

    def seed(self, key, body, **metadata):
        self.objects[key] = {'body': body, 'ETag': '"' + hashlib.md5(body).hexdigest() + '"',
                             'ContentType': 'text/html', 'CacheControl': static.HTML_CACHE, **metadata}

    def get_paginator(self, _name):
        return self

    def paginate(self, **kwargs):
        return [{'Contents': [{'Key': key, 'ETag': value['ETag']} for key, value in self.objects.items()
                              if key.startswith(kwargs['Prefix'])]}]

    def get_object(self, **kwargs):
        if kwargs['Key'] not in self.objects:
            raise self.exceptions.NoSuchKey()
        value = self.objects[kwargs['Key']]
        return {key: item for key, item in value.items() if key != 'body'} | {'Body': io.BytesIO(value['body'])}

    def put_object(self, **kwargs):
        key = kwargs['Key']
        if 'IfMatch' in kwargs:
            assert self.objects[key]['ETag'] == kwargs['IfMatch']
        else:
            assert kwargs['IfNoneMatch'] == '*' and key not in self.objects
        self.writes.append(key)
        self.seed(key, kwargs['Body'], ContentType=kwargs.get('ContentType'), CacheControl=kwargs.get('CacheControl'))


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        self.tmp = Path(self.contexts.enter_context(tempfile.TemporaryDirectory()))
        self.root = self.tmp / 'space'
        self.build = self.root / 'client/dist'
        self.main_build = self.tmp / 'entropydrop_frontend/dist'
        self.backup = self.tmp / 'backup'
        self.backup.mkdir()
        self.state = self.tmp / 'state'
        self.mock('ROOT', new=self.root)
        self.mock('STATE', new=self.state)
        self.s3 = FakeS3()
        self.cf = Mock()
        self.cf.get_distribution.return_value = {'Distribution': {'Status': 'Deployed'}}
        self.cf.get_distribution_config.return_value = {'ETag': 'config-etag', 'DistributionConfig': {
            'Origins': {'Items': [{'Id': 'space-static', 'OriginPath': '/space-app/previous'}]},
            'DefaultCacheBehavior': {'FunctionAssociations': {'Items': [{
                'EventType': 'viewer-request', 'FunctionARN': 'arn:aws:cloudfront::123:function/entropydrop-frontend-router',
            }]}}, 'WebACLId': 'keep-firewall', 'CacheBehaviors': {'Items': []},
        }}
        self.mock('client', side_effect=lambda service, *_args: self.s3 if service == 's3' else self.cf)
        self.make_build(self.build)
        self.make_build(self.main_build, main=True)

    def mock(self, name, **kwargs):
        return self.contexts.enter_context(patch.object(deploy, name, **kwargs))

    def make_build(self, path, main=False):
        (path / 'assets').mkdir(parents=True)
        (path / 'assets/app-123.js').write_bytes(b'current javascript')
        (path / 'index.html').write_text('<script src="/assets/app-123.js"></script>')
        if main:
            for route in static.MAIN_ROUTES:
                (path / route).mkdir(parents=True, exist_ok=True)
                (path / route / 'index.html').write_bytes((path / 'index.html').read_bytes())

    def test_all_legacy_aliases_are_updated_backed_up_and_published_after_assets(self):
        for route in static.MAIN_ROUTES:
            self.s3.seed(route, b'old page')
        self.s3.seed('space-app/precious/assets/old.js', b'keep previous release')
        deploy.upload(self.main_build, '', aliases=static.MAIN_ROUTES, backup_dir=self.backup)
        for route in static.MAIN_ROUTES:
            self.assertEqual(self.s3.objects[route]['body'], (self.main_build / 'index.html').read_bytes())
            self.assertEqual(self.s3.objects[route]['ContentType'], 'text/html')
        rollback = json.loads((self.backup / 'objects-before.json').read_text())
        self.assertEqual({entry['key'] for entry in rollback}, set(static.MAIN_ROUTES))
        self.assertTrue(all((self.backup / entry['backup']).read_bytes() == b'old page' for entry in rollback))
        self.assertEqual(self.s3.writes[0], 'assets/app-123.js')
        self.assertEqual(self.s3.objects['space-app/precious/assets/old.js']['body'], b'keep previous release')

    def test_missing_or_stale_entry_stops_before_any_write(self):
        (self.main_build / 'space/intro/index.html').write_text('stale')
        with self.assertRaisesRegex(RuntimeError, 'stale generated entry'):
            deploy.upload(self.main_build, '', aliases=static.MAIN_ROUTES)
        self.assertFalse(self.s3.writes)

    def test_hash_named_asset_collision_stops_before_any_write(self):
        self.s3.seed('assets/app-123.js', b'different bytes')
        with self.assertRaisesRegex(RuntimeError, 'Immutable'):
            deploy.upload(self.main_build, '', aliases=static.MAIN_ROUTES)
        self.assertFalse(self.s3.writes)

    def test_immutable_release_cannot_be_reused_for_another_build(self):
        self.s3.seed('space-app/reused/index.html', b'previous release')
        with self.assertRaisesRegex(RuntimeError, 'Immutable'):
            deploy.upload(self.build, 'space-app/reused/', immutable=True)
        self.assertFalse(self.s3.writes)

    def test_matching_html_with_bad_cache_metadata_is_corrected(self):
        self.s3.seed('index.html', (self.build / 'index.html').read_bytes(), CacheControl='public,max-age=86400')
        deploy.upload(self.build, '', backup_dir=self.backup)
        self.assertEqual(self.s3.objects['index.html']['CacheControl'], static.HTML_CACHE)

    def test_prepare_uploads_before_switch_and_preserves_distribution_settings(self):
        self.mock('validate_production_build')
        self.mock('distribution', return_value={'Id': 'space-distribution'})
        self.s3.seed('space-app/previous/assets/older.js', b'old immutable chunk')
        self.mock('finish_space_release')
        def switch(**kwargs):
            self.assertIn('space-app/new/index.html', self.s3.objects)
            self.assertIn('space-app/new/assets/older.js', self.s3.objects)
            self.assertEqual(kwargs['IfMatch'], 'config-etag')
            config = kwargs['DistributionConfig']
            self.assertEqual(config['WebACLId'], 'keep-firewall')
            self.assertEqual(config['Origins']['Items'][0]['OriginPath'], '/space-app/new')
            return {'Distribution': {'Id': 'space-distribution'}}
        self.cf.update_distribution.side_effect = switch
        deploy.prepare('new')
        self.cf.update_distribution.assert_called_once()

    def test_failed_object_verification_never_switches_origin(self):
        self.mock('validate_production_build')
        self.mock('distribution', return_value={'Id': 'space-distribution'})
        self.mock('verify_objects', side_effect=RuntimeError('staged mismatch'))
        with self.assertRaisesRegex(RuntimeError, 'staged mismatch'):
            deploy.prepare('new')
        self.cf.update_distribution.assert_not_called()

    def test_missing_router_on_specific_behavior_blocks_main_upload(self):
        self.mock('validate_production_build')
        self.cf.get_distribution_config.return_value['DistributionConfig']['CacheBehaviors']['Items'] = [
            {'PathPattern': '/space/intro*', 'FunctionAssociations': {'Items': []}},
        ]
        with self.assertRaisesRegex(RuntimeError, 'bypasses'):
            deploy.upload_main()
        self.assertFalse(self.s3.writes)
        self.cf.publish_function.assert_not_called()

    def test_main_release_waits_before_live_verification_and_propagates_failure(self):
        self.mock('validate_production_build')
        self.mock('redirect_main')
        self.mock('invalidate', return_value='invalidation')
        order = []
        self.mock('wait_for_cdn', side_effect=lambda *_a, **_k: order.append('wait'))
        def verify(*_args, **_kwargs):
            self.assertEqual(order, ['wait'])
            raise RuntimeError('old alias still live')
        self.mock('verify_online', side_effect=verify)
        with self.assertRaisesRegex(RuntimeError, 'old alias still live'):
            deploy.upload_main()
        self.assertFalse(list(self.state.glob('releases/*/verification.json')))


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.build = Path(self.temp.name)
        ReleaseTests.make_build(self, self.build, main=True)
        self.paths = []

    def fetch(self, url):
        from urllib.parse import urlsplit, quote
        parsed = urlsplit(url)
        path = parsed.path
        self.paths.append(path)
        if path in static.LEGACY_ROUTES:
            target = 'https://space.entropydrop.com/?' + parsed.query
            return 302, {'Location': 'https://entropydrop.com/space/login?destination=' + quote(target, safe='')}, b''
        file = self.build / path.lstrip('/')
        if file.is_dir():
            file /= 'index.html'
        return 200, {'Content-Type': 'text/html' if file.suffix == '.html' else 'application/javascript'}, file.read_bytes()

    def test_verifies_all_entry_variants_assets_and_legacy_world_redirects(self):
        report = static.verify_online(self.build, 'https://entropydrop.com', '', main=True, fetcher=self.fetch)
        self.assertEqual(report['assets_verified'], 1)
        for route in static.MAIN_ROUTES:
            for suffix in ('', '/', '/index.html'):
                self.assertIn('/' + route + suffix, self.paths)

    def test_http_200_with_stale_html_is_a_release_failure(self):
        def fetch(url):
            if url.endswith('/space/intro'):
                return 200, {'Content-Type': 'text/html'}, b'old entry'
            return self.fetch(url)
        with self.assertRaisesRegex(RuntimeError, 'Live release mismatch: /space/intro'):
            static.verify_online(self.build, 'https://entropydrop.com', '', main=True, fetcher=fetch)

    def test_redirect_losing_world_parameter_is_a_release_failure(self):
        def fetch(url):
            if '/space/app' in url:
                return 302, {'Location': 'https://space.entropydrop.com/'}, b''
            return self.fetch(url)
        with self.assertRaisesRegex(RuntimeError, 'loses world parameters'):
            static.verify_online(self.build, 'https://entropydrop.com', '', main=True, fetcher=fetch)

    def test_direct_standalone_redirect_is_valid_when_parameters_are_preserved(self):
        from urllib.parse import urlsplit
        def fetch(url):
            if '/space/app' in url:
                return 302, {'Location': 'https://space.entropydrop.com/?' + urlsplit(url).query}, b''
            return self.fetch(url)
        report = static.verify_online(self.build, 'https://entropydrop.com', '', main=True, fetcher=fetch)
        self.assertTrue(report['legacy_redirects_verified'])

    def test_asset_missing_from_build_fails_preflight(self):
        (self.build / 'assets/app-123.js').unlink()
        with self.assertRaisesRegex(RuntimeError, 'missing build asset'):
            static.manifest(self.build, main=True)

    def test_new_generated_route_must_be_added_to_the_release_contract(self):
        (self.build / 'space/new-page').mkdir()
        (self.build / 'space/new-page/index.html').write_bytes((self.build / 'index.html').read_bytes())
        with self.assertRaisesRegex(RuntimeError, 'missing from the release route list'):
            static.manifest(self.build, main=True)

    def test_snapshot_rejects_a_build_changed_during_copy(self):
        # Keep staging outside the build tree, as publication does.
        with tempfile.TemporaryDirectory() as staging:
            copy = static.shutil.copytree
            def change_build(source, target, *args, **kwargs):
                result = copy(source, target, *args, **kwargs)
                if Path(source) == self.build:
                    (self.build / 'index.html').write_text('changed after copy')
                return result
            with patch.object(static.shutil, 'copytree', side_effect=change_build):
                with self.assertRaisesRegex(RuntimeError, 'stale generated entry|changed while staging'):
                    static.snapshot_build(self.build, Path(staging), main=True)

    def test_timeout_is_failure_even_when_distribution_is_deployed(self):
        cf = Mock()
        cf.get_distribution.return_value = {'Distribution': {'Status': 'Deployed'}}
        cf.get_invalidation.return_value = {'Invalidation': {'Status': 'InProgress'}}
        with patch.object(static.time, 'monotonic', side_effect=[0, 1]):
            with self.assertRaisesRegex(RuntimeError, 'timed out'):
                static.wait_for_cdn(cf, 'distribution', 'invalidation', timeout=1)

    def test_parallel_local_publications_are_rejected(self):
        with static.release_lock(self.build):
            with self.assertRaisesRegex(RuntimeError, 'already running'):
                with static.release_lock(self.build):
                    self.fail('second writer acquired lock')


if __name__ == '__main__':
    unittest.main()
