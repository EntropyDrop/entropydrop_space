#!/usr/bin/env node
// Keep repository text English-only while allowing Greek letters in formulas.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: workspaceRoot, encoding: 'utf8' },
).split('\0').filter(file => file && existsSync(join(workspaceRoot, file)));

const letter = /\p{Letter}/u;
const allowedLetter = /[\p{Script=Latin}\p{Script=Greek}]/u;
const cjkPunctuation = /[\u3001\u3002\u3008-\u3011\u3014-\u301f\u3030\u303e\u303f\uff01\uff08\uff09\uff0c\uff0f\uff1a\uff1b\uff1f]/u;
const violations = [];

function firstDisallowedCharacter(value) {
  return [...value].find(character => (
    (letter.test(character) && !allowedLetter.test(character))
    || cjkPunctuation.test(character)
  ));
}

for (const file of files) {
  const pathCharacter = firstDisallowedCharacter(file);
  if (pathCharacter) {
    violations.push(`${file}: filename contains ${JSON.stringify(pathCharacter)}`);
    continue;
  }

  const bytes = readFileSync(join(workspaceRoot, file));
  if (bytes.includes(0)) continue;
  const lines = bytes.toString('utf8').split('\n');
  lines.forEach((line, index) => {
    const character = firstDisallowedCharacter(line);
    if (character) {
      violations.push(`${file}:${index + 1}: contains ${JSON.stringify(character)}`);
    }
  });
}

if (violations.length > 0) {
  console.error('Non-English text found:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`English-only text check passed (${files.length} files).`);
