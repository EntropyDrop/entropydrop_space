import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { logConsoleSecurityWarning } from '../src/bootstrap/ConsoleSecurityWarning.ts';

test('console security warning cautions against pasted code and browser-storage API-key theft', () => {
  const calls: unknown[][] = [];
  logConsoleSecurityWarning((...data) => calls.push(data));

  const output = calls.flat().join(' ');
  assert.match(output, /SECURITY WARNING/);
  assert.match(output, /Do not paste code/);
  assert.match(output, /localStorage/);
  assert.match(output, /sessionStorage/);
  assert.match(output, /API Key/i);
});

test('app startup logs the console warning and entity assistant settings retain the API-key notice', () => {
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const editorSource = readFileSync(new URL('../src/ui/react/components/EditorModal.tsx', import.meta.url), 'utf8');
  const noticeSource = readFileSync(new URL('../src/ui/react/components/AgentApiKeySecurityNotice.tsx', import.meta.url), 'utf8');

  assert.match(mainSource, /logConsoleSecurityWarning\(\)/);
  assert.match(editorSource, /<AgentApiKeySecurityNotice/);
  assert.match(noticeSource, /Plaintext storage warning/);
  assert.match(noticeSource, /saved unencrypted/);
  assert.match(noticeSource, /localStorage/);
  assert.match(noticeSource, /sessionStorage/);
  assert.match(noticeSource, /cleared when the tab closes/);
  assert.match(editorSource, /rememberApiKey/);
  assert.match(editorSource, /Persist API key on this device \(plaintext localStorage\)/);
});

test('Agent Build distinguishes full-access Space credentials from model API keys', () => {
  const source = readFileSync(new URL('../src/ui/react/components/AgentBuildModal.tsx', import.meta.url), 'utf8');
  assert.match(source, /A spaceAPI key grants full Space access/);
  assert.match(source, /agent you trust/);
  assert.match(source, /revoke it here/);
  assert.match(source, /This is not a model API key/);
  assert.doesNotMatch(source, /rememberApiKey|localStorage|sessionStorage|saveAgentSettings/);
});
