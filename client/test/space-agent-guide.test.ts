import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceApiKeyClient } from '../src/bootstrap/SpaceApiKeyClient.ts';
import { spaceAgentConnection, spaceAgentPrompt } from '../src/bootstrap/SpaceAgentGuide.ts';
import { apiDocsBodyMarkup } from '../src/ui/react/apiDocsMarkup.ts';

test('agent connection uses the Space origin independently of account authentication', () => {
  const client = new SpaceApiKeyClient('https://accounts.example.test', 'private-login-token', fetch, 'https://space.example.test/');
  assert.deepEqual(client.getAgentConnection(), {
    origin: 'https://space.example.test',
    worldSelector: 'default',
    worldsUrl: 'https://space.example.test/space/api/v2/worlds',
    skillUrl: 'https://space.example.test/space/agent/SKILL.md',
    spaceApiUrl: 'https://space.example.test/space/agent/spaceAPI.md',
    entityApiUrl: 'https://space.example.test/space/agent/entityAPI.md',
    positionUrl: 'https://space.example.test/space/api/v2/players/me/position?world=default',
  });
});

test('agent handoff retains the selected world for positions, writes and retries', () => {
  for (const world of ['aether-archipelago', 'nature', 'copper-metropolis', '00000000-0000-4000-8000-000000000003']) {
    const client = new SpaceApiKeyClient('https://accounts.example.test', 'private-login-token', fetch, 'https://space.example.test');
    const connection = client.getAgentConnection(world);
    assert.equal(connection.worldSelector, world);
    assert.equal(new URL(connection.positionUrl).searchParams.get('world'), world);
    const prompt = spaceAgentPrompt(connection.origin, connection.worldSelector);
    assert.ok(prompt.includes(`Target world: "${world}"`));
    assert.ok(prompt.includes('use that same ID'));
    assert.ok(prompt.includes('Do not use another world'));
    assert.ok(!prompt.includes('private-login-token'));
  }
});

test('copyable instructions strip legacy account paths and never include URL credentials', () => {
  const origin = 'https://user:secret@example.test/skin?token=private';
  const guide = spaceAgentConnection(origin);
  assert.equal(guide.origin, 'https://example.test');
  const markup = apiDocsBodyMarkup(origin);
  assert.ok(markup.includes(guide.spaceApiUrl));
  assert.ok(markup.includes(guide.entityApiUrl));
  assert.ok(!/secret|token=|user:/.test(markup));
  const prompt = spaceAgentPrompt(origin);
  assert.ok(prompt.includes(guide.skillUrl));
  assert.ok(prompt.includes('browser authorization'));
  assert.ok(prompt.includes('wait for me to approve'));
  assert.ok(prompt.includes('without asking me to copy a key'));
  assert.ok(!/secret|token=|user:/.test(prompt));
});
