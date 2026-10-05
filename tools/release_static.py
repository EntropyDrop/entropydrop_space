"""Static release checks shared by publication and read-only verification."""
from contextlib import contextmanager
import fcntl
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import shutil
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


MAIN_ROUTES = (
    'space', 'space/intro', 'space/apikeys', 'space/authorize', 'space/login',
    'space/monitor', 'space/monitoring',
)
LEGACY_ROUTES = ('/space/app', '/space/app/', '/space/app/index.html')
HTML_CACHE = 'no-cache, no-store, must-revalidate'


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), 'w') as output:
        json.dump(value, output, indent=2, default=str)


@contextmanager
def release_lock(state):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'static-release.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another static release is already running.') from error
        yield


class AssetReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        value = attrs.get('src') if tag == 'script' else attrs.get('href') if tag == 'link' else None
        if value and not urlsplit(value).netloc:
            path = urlsplit(value).path.lstrip('/')
            if path.startswith('assets/'):
                self.paths.add(path)


def manifest(directory, *, main=False):
    directory = Path(directory)
    files = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise RuntimeError(f'Build output contains a symlink: {path.name}')
        if path.is_file():
            files[path.relative_to(directory).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    if 'index.html' not in files:
        raise RuntimeError('Build output is missing index.html')
    if main:
        for route in MAIN_ROUTES:
            if files.get(route + '/index.html') != files['index.html']:
                raise RuntimeError(f'Missing or stale generated entry: /{route}/index.html')
        generated = {name[:-len('/index.html')] for name in files
                     if name.startswith('space/') and name.endswith('/index.html')}
        unknown = generated - set(MAIN_ROUTES) - {'space/app'}
        if unknown:
            raise RuntimeError('Generated Space entries are missing from the release route list: ' + ', '.join(sorted(unknown)))
    for name in files:
        if name.endswith('.html'):
            parser = AssetReferences()
            parser.feed((directory / name).read_text())
            for reference in parser.paths:
                if reference not in files:
                    raise RuntimeError(f'{name} references a missing build asset: {reference}')
    return files


def snapshot_build(directory, run_dir, *, main=False):
    before = manifest(directory, main=main)
    target = run_dir / 'build'
    shutil.copytree(directory, target)
    if manifest(target, main=main) != before or manifest(directory, main=main) != before:
        raise RuntimeError('Build output changed while staging; build again before publishing.')
    write_json(run_dir / 'manifest.json', {'main': main, 'sha256': before})
    return target, before


def wait_for_cdn(cf, distribution_id, invalidation_id=None, *, timeout=900):
    deadline = time.monotonic() + timeout
    while True:
        deployed = cf.get_distribution(Id=distribution_id)['Distribution']['Status'] == 'Deployed'
        invalidated = not invalidation_id or cf.get_invalidation(
            DistributionId=distribution_id, Id=invalidation_id)['Invalidation']['Status'] == 'Completed'
        if deployed and invalidated:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('CDN deployment or invalidation timed out; release is not verified.')
        time.sleep(min(5, max(0, deadline - time.monotonic())))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url, proxy):
    opener = build_opener(ProxyHandler({'http': proxy, 'https': proxy}), NoRedirect())
    try:
        response = opener.open(url, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers.items()), response.read()


def verify_online(directory, origin, proxy, *, main=False, fetcher=None):
    """Fetch real entry URLs (without cache-busting) and all current assets."""
    expected = manifest(directory, main=main)
    fetcher = fetcher or (lambda url: fetch(url, proxy))
    entries = {'/': 'index.html', '/index.html': 'index.html'}
    if main:
        for route in MAIN_ROUTES:
            for suffix in ('', '/', '/index.html'):
                entries['/' + route + suffix] = route + '/index.html'
    else:
        entries.update({'/?world=nature': 'index.html', '/?world=copper-metropolis': 'index.html'})
    assets = {name for name in expected if name.startswith('assets/')}

    def check(path, name):
        status, headers, body = fetcher(origin + path)
        headers = {key.lower(): value for key, value in headers.items()}
        if status != 200 or hashlib.sha256(body).hexdigest() != expected[name]:
            raise RuntimeError(f'Live release mismatch: {path} (HTTP {status})')
        if name.endswith('.html') and 'text/html' not in headers.get('content-type', ''):
            raise RuntimeError(f'Entry is not served as HTML: {path}')

    for path, name in entries.items():
        check(path, name)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda name: check('/' + quote(name, safe='/'), name), sorted(assets)))
    if main:
        query = '?world=copper-metropolis&tag=a&tag=b'
        for path in LEGACY_ROUTES:
            status, headers, _body = fetcher(origin + path + query)
            headers = {key.lower(): value for key, value in headers.items()}
            redirect = urlsplit(headers.get('location', ''))
            # Both the standalone login flow and the main-site SSO handoff are
            # supported. Verify their final destination instead of requiring
            # one historical redirect shape.
            if redirect.scheme == 'https' and redirect.netloc == 'entropydrop.com' and redirect.path == '/space/login':
                target = urlsplit(parse_qs(redirect.query).get('destination', [''])[0])
            else:
                target = redirect
            if (status not in (301, 302, 307, 308) or target.scheme != 'https'
                    or target.netloc != 'space.entropydrop.com' or target.path != '/'
                    or parse_qs(target.query) != {'world': ['copper-metropolis'], 'tag': ['a', 'b']}):
                raise RuntimeError(f'Legacy Space redirect is stale or loses world parameters: {path}')
    return {'entries': list(entries), 'assets_verified': len(assets),
            'index_sha256': expected['index.html'], 'legacy_redirects_verified': main}
