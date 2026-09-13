import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { logConsoleSecurityWarning } from '../src/bootstrap/ConsoleSecurityWarning.ts';

test('console security warning cautions against pasted code and browser-storage API-key theft', () => {
  const calls: unknown[][] = [];
  logConsoleSecurityWarning((...data) => calls.push(data));

  const output = calls.flat().join(' ');
  assert.match(output, /SECURITY WARNING/);
  assert.match(output, /不要在控制台粘贴/);
  assert.match(output, /Do not paste code/);
  assert.match(output, /localStorage/);
  assert.match(output, /sessionStorage/);
  assert.match(output, /API Key/i);
});

test('app startup logs the console warning and both assistant settings show the API-key notice', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const editorSource = readFileSync(new URL('../src/ui/react/components/EditorModal.tsx', import.meta.url), 'utf8');
  const builderSource = readFileSync(new URL('../src/ui/react/components/BuildAssistantModal.tsx', import.meta.url), 'utf8');
  const noticeSource = readFileSync(new URL('../src/ui/react/components/AgentApiKeySecurityNotice.tsx', import.meta.url), 'utf8');

  assert.match(mainSource, /logConsoleSecurityWarning\(\)/);
  assert.match(editorSource, /<AgentApiKeySecurityNotice/);
  assert.match(builderSource, /<AgentApiKeySecurityNotice/);
  assert.match(noticeSource, /Plaintext storage warning/);
  assert.match(noticeSource, /saved unencrypted/);
  assert.match(noticeSource, /localStorage/);
  assert.match(noticeSource, /sessionStorage/);
  assert.match(noticeSource, /cleared when the tab closes/);
  assert.match(editorSource, /rememberApiKey/);
  assert.match(builderSource, /rememberApiKey/);
  assert.match(editorSource, /Persist API key on this device \(plaintext localStorage\)/);
  assert.match(builderSource, /Persist API key on this device \(plaintext localStorage\)/);
});
