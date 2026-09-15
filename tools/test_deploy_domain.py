"""Verify Space static routing without accessing production services."""
import ast
import json
from pathlib import Path
import subprocess
import unittest


def router_source():
    tree = ast.parse(Path(__file__).with_name('deploy_domain.py').read_text())
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'redirect_main')
    call = next(node.value for node in function.body if isinstance(node, ast.Expr)
                and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                and node.value.func.id == 'publish_function')
    return ast.literal_eval(call.args[1])


class SpaceStaticRouterTests(unittest.TestCase):
    def route(self, uri, query=None):
        script = "const vm=require('node:vm');const data=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(vm.runInNewContext(data.code+';handler(event)',{event:data.event})));"
        result = subprocess.run(['node', '-e', script, json.dumps({
            'code': router_source(), 'event': {'request': {'uri': uri, 'querystring': query or {}}},
        })], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    def test_extensionless_space_pages_use_current_generated_entries(self):
        for uri in ['/space', '/space/intro', '/space/apikeys', '/space/login', '/space/monitor', '/space/monitoring']:
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


if __name__ == '__main__':
    unittest.main()
