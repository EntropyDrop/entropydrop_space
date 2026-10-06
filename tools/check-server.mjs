import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const localPython = join(root, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.SPACE_PYTHON || (existsSync(localPython) ? localPython : 'python3');
for (const [args, cwd] of [
  [['tools/sync_server_contracts.py', '--check', '--protobuf'], root],
  [['-m', 'pytest', '-q'], join(root, 'server')],
]) {
  const result = spawnSync(python, args, { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    console.error('Install server/requirements-dev.txt in server/.venv or set SPACE_PYTHON.');
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Server check failed: ${args.join(' ')} (${result.signal || `exit ${result.status}`}).`);
    process.exit(result.status || 1);
  }
}
