import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractSpaceBuildPlan,
  runSpaceBuildAgentTurn
} from '../src/engine/building/BuildAgent.ts';

test('BuildAgent extracts strict raw or fenced JSON plans', () => {
  assert.deepEqual(extractSpaceBuildPlan('{"version":1,"kind":"structure","blocks":[]}'), {
    version: 1,
    kind: 'structure',
    blocks: []
  });
  assert.equal(extractSpaceBuildPlan('```json\n{"kind":"entity","blocks":[]}\n```')?.kind, 'entity');
  assert.equal(extractSpaceBuildPlan('not a plan'), null);
  assert.equal(extractSpaceBuildPlan('{broken}'), null);
});

test('BuildAgent requires configured model transport', async () => {
  const result = await runSpaceBuildAgentTurn('build a house', { apiKey: '' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Configure a model API key/);
});

test('BuildAgent returns a parsed BuildPlan from an OpenAI-compatible response', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          version: 1,
          kind: 'structure',
          name: 'Tower',
          anchor: 'crosshair',
          primitives: [{ type: 'box', from: [0, 0, 0], to: [2, 5, 2], hollow: true }]
        })
      }
    }]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
  const result: any = await runSpaceBuildAgentTurn('build a tower', {
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'test-model',
    contextKTokens: 8,
    maxOutputKTokens: 1
  }, [], null, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.plan.kind, 'structure');
  assert.equal(result.plan.name, 'Tower');
});
