#!/usr/bin/env node
// Fail on broken local Markdown links in the Space app documentation.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(appRoot, '..');
const roots = [
  join(workspaceRoot, 'README.md'),
  join(appRoot, 'README.md'),
  join(appRoot, 'CONTRIBUTING.md'),
  join(appRoot, 'CHANGELOG.md'),
  join(appRoot, 'docs'),
  join(workspaceRoot, 'engine', 'README.md'),
  join(workspaceRoot, 'engine', 'docs'),
  join(workspaceRoot, 'server', 'README.md'),
  join(workspaceRoot, 'server', 'docs'),
  join(workspaceRoot, 'server', 'space', 'agent'),
  join(workspaceRoot, 'proto', 'README.md'),
];

const files = [];
function collect(path) {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) collect(join(path, entry));
  } else if (path.endsWith('.md')) {
    files.push(path);
  }
}
roots.forEach(collect);

const missing = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      let url = match[1].trim();
      if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
      if (/^(https?:|mailto:|#)/.test(url)) continue;
      const target = url.split('#')[0];
      if (!target) continue;
      if (!existsSync(resolve(dirname(file), target))) {
        missing.push(`${relative(workspaceRoot, file)}:${index + 1} -> ${target}`);
      }
    }
  });
}

if (missing.length > 0) {
  console.error('Broken local documentation links:');
  for (const entry of missing) console.error(`  ${entry}`);
  process.exit(1);
}
console.log(`Documentation links OK (${files.length} files).`);
