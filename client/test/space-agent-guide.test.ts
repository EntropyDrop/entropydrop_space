import test from 'node:test';
import assert from 'node:assert/strict';
import { SpaceApiKeyClient } from '../src/bootstrap/SpaceApiKeyClient.ts';
import { spaceAgentConnection, spaceAgentPrompt } from '../src/bootstrap/SpaceAgentGuide.ts';
import { apiDocsBodyMarkup } from '../src/ui/react/apiDocsMarkup.ts';

test('agent connection uses the Space origin independently of account authentication', () => {
  const client = new SpaceApiKeyClient('https://accounts.example.test', 'private-login-token', fetch, 'https://space.example.test/');
  assert.deepEqual(client.getAgentConnection(), {
    origin: 'https://space.example.test',
    skillUrl: 'https://space.example.test/space/agent/SKILL.md',
    spaceApiUrl: 'https://space.example.test/space/agent/spaceAPI.md',
    entityApiUrl: 'https://space.example.test/space/agent/entityAPI.md',
    positionUrl: 'https://space.example.test/space/api/v2/players/me/position',
  });
});

test('copyable instructions strip legacy account paths and never include URL credentials', () => {
  const origin = 'https://user:secret@example.test/skin?token=private';
  const guide = spaceAgentConnection(origin);
  assert.equal(guide.origin, 'https://example.test');
  const markup = apiDocsBodyMarkup(origin);
  assert.ok(markup.includes(guide.spaceApiUrl));
  assert.ok(markup.includes(guide.entityApiUrl));
  assert.ok(!/secret|token=|user:/.test(markup));
  for (const zh of [false, true]) {
    const prompt = spaceAgentPrompt(origin, zh);
    assert.ok(prompt.includes(guide.skillUrl));
    assert.ok(!/secret|token=|user:/.test(prompt));
  }
});
