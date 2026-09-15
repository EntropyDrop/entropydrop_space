"""Offline validation of the private development gateway; no live mutations."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy_dev_web', Path(__file__).with_name('deploy_dev_web.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

CONFIG = '''
location /api/ { proxy_pass http://127.0.0.1:18082; }
location /skin/api/ { proxy_pass http://127.0.0.1:18082; }
location /internal/ { return 404; }
'''


class DevelopmentGatewayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / 'deploy/dev-domain/nginx.conf'
        self.config.parent.mkdir(parents=True)

    def validate(self, config):
        self.config.write_text(config)
        deploy.validate_gateway_config(self.config)

    def test_both_account_api_aliases_and_private_rpc_block_are_required(self):
        self.validate(CONFIG)
        for line in CONFIG.strip().splitlines():
            with self.subTest(line=line):
                with self.assertRaises(RuntimeError):
                    self.validate(CONFIG.replace(line, ''))

    def test_production_account_upstream_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'Mac account API'):
            self.validate(CONFIG.replace('http://127.0.0.1:18082', 'https://api.entropydrop.com', 1))

    def test_invalid_gateway_fails_before_upload_or_container_changes(self):
        self.config.write_text(CONFIG.replace('location /api/ { proxy_pass http://127.0.0.1:18082; }', ''))
        with patch.object(deploy, 'ROOT', self.root), patch.object(deploy, 'ssh') as ssh:
            with self.assertRaisesRegex(RuntimeError, '/api/'):
                deploy.main()
            ssh.assert_not_called()


if __name__ == '__main__':
    unittest.main()
