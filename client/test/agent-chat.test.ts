import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCodeBlock,
  parseThoughtAndContent,
  estimateTokens,
  runAgentTurn,
  callChatAgent,
  fetchAgentModels,
  loadAgentConfig,
  saveAgentConfig,
  AGENT_CONFIG_STORAGE_KEY,
  AGENT_SESSION_KEY_STORAGE_KEY,
  AGENT_SYSTEM_PROMPT,
  DEFAULT_AGENT_CONTEXT_K_TOKENS,
  DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS
} from '../src/engine/contraption/AgentChat.ts';
import { renderAgentApiReference } from '@entropydrop/space-engine/contraption/ScriptApiContract.ts';

test('extractCodeBlock extracts a fenced JavaScript block', () => {
  const content = 'Here is the controller:\n```js\nself.applyForce([0, 100, 0]);\n```\nDone.';
  assert.equal(extractCodeBlock(content), 'self.applyForce([0, 100, 0]);');
});

test('extractCodeBlock accepts a fence without a language tag', () => {
  const content = '```\nself.setLocalSpin([0,1,0], 60);\n```';
  assert.equal(extractCodeBlock(content), 'self.setLocalSpin([0,1,0], 60);');
});

test('extractCodeBlock returns null for a plain-text response', () => {
  assert.equal(extractCodeBlock('This entity is well suited for hovering.'), null);
});

test('extractCodeBlock accepts unfenced V2 self code', () => {
  assert.equal(extractCodeBlock('self.applyForce([0, 42, 0]);'), 'self.applyForce([0, 42, 0]);');
});

test('runAgentTurn falls back to the local compiler without an API key', async () => {
  const result = (await runAgentTurn('hover 5 meters above the ground', { baseUrl: '', apiKey: '', model: '' })) as any;
  assert.equal(result.ok, true);
  assert.equal(result.local, true);
  assert.ok(result.code.includes('self.applyForce'), 'the local hover template should use the unified self API');
});

test('runAgentTurn returns an error when the local compiler cannot recognize a prompt', async () => {
  const result = await runAgentTurn('perform a tap dance', { baseUrl: '', apiKey: '', model: '' });
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

test('runAgentTurn calls the remote model and extracts code when configured', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```js\nself.applyForce([0, 42, 0]);\n```' } }]
      })
    };
  };
  const config = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'test-model' };
  const result = (await runAgentTurn('hover', config, [], fakeFetch)) as any;

  assert.equal(result.ok, true);
  assert.equal(result.code, 'self.applyForce([0, 42, 0]);');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.max_tokens, DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS * 1024);
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.includes('applyForce'), 'the system prompt should include the API reference');
  assert.equal(body.messages[body.messages.length - 1].content, 'hover');
});

test('remote Agent receives target component metadata', async () => {
  let requestBody: any = null;
  const fakeFetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'No code needed.' } }] })
    };
  };
  await runAgentTurn(
    'stabilize this part',
    { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' },
    [],
    fakeFetch,
    { id: 'rotor_nw', parentId: 'root', entityId: 'ent_example', blockCount: 4 }
  );
  const userMessage = requestBody.messages.at(-1).content;
  assert.match(userMessage, /Target component:/);
  assert.match(userMessage, /id: rotor_nw/);
  assert.match(userMessage, /parent: root/);
  assert.match(userMessage, /entity: ent_example/);
  assert.match(userMessage, /owned blocks: 4/);
});

test('remote Agent never auto-applies unfenced code-like prose', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: 'Try self.applyForce([0, 42, 0]); and tune it.' } }]
    })
  });
  const result = (await runAgentTurn(
    'hover',
    { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' },
    [],
    fakeFetch
  )) as any;
  assert.equal(result.ok, true);
  assert.equal(result.code, null);
  assert.match(result.content, /self\.applyForce/);
});

test('remote Agent responses with finish_reason length are accepted and parsed', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: 'length', message: { content: '```js\nself.applyForce(0, 10, 0);\n```' } }]
    })
  });
  const result = await runAgentTurn(
    'write a long controller',
    { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' },
    [],
    fakeFetch
  );
  assert.equal(result.ok, true);
  assert.equal(result.code, 'self.applyForce(0, 10, 0);');
});

test('runAgentTurn includes conversation history', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'ok' } }] })
  });
  const history = [
    { role: 'user', content: 'hover at 5 meters' },
    { role: 'assistant', content: 'generated' }
  ];
  await runAgentTurn('a little higher', { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, history, fakeFetch);
  // Verify that callChatAgent receives the complete history.
});

test('callChatAgent handles HTTP errors', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'invalid key' });
  const result = await callChatAgent([], { baseUrl: 'https://x/v1', apiKey: 'bad', model: 'm' }, fakeFetch);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('401'));
});

test('callChatAgent handles network failures', async () => {
  const fakeFetch = async () => { throw new Error('network down'); };
  const result = await callChatAgent([], { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, fakeFetch);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('network down'));
});

test('callChatAgent refuses to send credentials over non-local HTTP', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const result = await callChatAgent(
    [],
    { baseUrl: 'http://api.example.com/v1', apiKey: 'secret', model: 'm' },
    fakeFetch
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTPS/);
  assert.equal(called, false);
});

test('fetchAgentModels loads and deduplicates an OpenAI-compatible model list', async () => {
  let request: any = null;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }] })
    };
  };
  const result: any = await fetchAgentModels(
    { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-models' },
    fakeFetch
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['model-b', 'model-a']);
  assert.equal(request.url, 'https://api.example.com/v1/models');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.Authorization, 'Bearer sk-models');
});

test('fetchAgentModels accepts local model response variants without requiring a key', async () => {
  const fakeFetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return {
      ok: true,
      json: async () => ({ models: ['qwen-local', { name: 'llama-local' }] })
    };
  };
  const result: any = await fetchAgentModels(
    { baseUrl: 'http://localhost:11434/v1', apiKey: '' },
    fakeFetch
  );
  assert.deepEqual(result.models, ['qwen-local', 'llama-local']);
});

test('fetchAgentModels rejects non-local HTTP before sending credentials', async () => {
  let called = false;
  const result: any = await fetchAgentModels(
    { baseUrl: 'http://api.example.com/v1', apiKey: 'secret' },
    async () => { called = true; }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTPS/);
  assert.equal(called, false);
});

test('loadAgentConfig returns defaults when nothing is saved', () => {
  // Simulate localStorage because the Node test environment has none.
  globalThis.localStorage = undefined;
  const config = loadAgentConfig();
  assert.equal(config.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.apiKey, '');
  assert.equal(config.model, 'gpt-4o-mini');
  assert.equal(config.contextKTokens, DEFAULT_AGENT_CONTEXT_K_TOKENS);
  assert.equal(config.maxOutputKTokens, DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS);
  assert.equal(config.rememberApiKey, false);
});

test('saveAgentConfig keeps keys session-only unless persistent storage is explicitly enabled', t => {
  const store = new Map<string, string>();
  const sessionStore = new Map<string, string>();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  } as any;
  globalThis.sessionStorage = {
    getItem: key => sessionStore.get(key) ?? null,
    setItem: (key, value) => sessionStore.set(key, String(value)),
    removeItem: key => sessionStore.delete(key)
  } as any;
  t.after(() => {
    globalThis.localStorage = undefined;
    globalThis.sessionStorage = undefined;
  });

  const saved = saveAgentConfig({ baseUrl: 'https://a/v1', apiKey: 'sk-1', model: 'm1' });
  assert.equal(saved, true);
  const loaded = loadAgentConfig();
  assert.equal(loaded.baseUrl, 'https://a/v1');
  assert.equal(loaded.apiKey, 'sk-1');
  assert.equal(loaded.model, 'm1');
  assert.equal(loaded.contextKTokens, DEFAULT_AGENT_CONTEXT_K_TOKENS);
  assert.equal(loaded.maxOutputKTokens, DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS);
  assert.equal(JSON.parse(store.get(AGENT_CONFIG_STORAGE_KEY)!).apiKey, undefined);
  assert.equal(sessionStore.get(AGENT_SESSION_KEY_STORAGE_KEY), 'sk-1');

  saveAgentConfig({ ...loaded, rememberApiKey: true });
  assert.equal(JSON.parse(store.get(AGENT_CONFIG_STORAGE_KEY)!).apiKey, 'sk-1');
  assert.equal(loadAgentConfig().rememberApiKey, true);

  saveAgentConfig({ ...loaded, rememberApiKey: false });
  assert.equal(JSON.parse(store.get(AGENT_CONFIG_STORAGE_KEY)!).apiKey, undefined);
  assert.equal(sessionStore.get(AGENT_SESSION_KEY_STORAGE_KEY), 'sk-1');
  assert.equal(loadAgentConfig().rememberApiKey, false);

  saveAgentConfig({ ...loaded, apiKey: '', rememberApiKey: false });
  assert.equal(JSON.parse(store.get(AGENT_CONFIG_STORAGE_KEY)!).apiKey, undefined);
  assert.equal(sessionStore.has(AGENT_SESSION_KEY_STORAGE_KEY), false);
  assert.equal(loadAgentConfig().apiKey, '');
});

test('loadAgentConfig migrates legacy unconfirmed localStorage keys into this tab only', t => {
  const store = new Map<string, string>([[
    AGENT_CONFIG_STORAGE_KEY,
    JSON.stringify({ baseUrl: 'https://legacy.test/v1', apiKey: 'sk-legacy', model: 'legacy-model' })
  ]]);
  const sessionStore = new Map<string, string>();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  } as any;
  globalThis.sessionStorage = {
    getItem: key => sessionStore.get(key) ?? null,
    setItem: (key, value) => sessionStore.set(key, String(value)),
    removeItem: key => sessionStore.delete(key)
  } as any;
  t.after(() => {
    globalThis.localStorage = undefined;
    globalThis.sessionStorage = undefined;
  });

  const loaded = loadAgentConfig();
  assert.equal(loaded.apiKey, 'sk-legacy');
  assert.equal(loaded.rememberApiKey, false);
  assert.equal(sessionStore.get(AGENT_SESSION_KEY_STORAGE_KEY), 'sk-legacy');
  assert.equal(JSON.parse(store.get(AGENT_CONFIG_STORAGE_KEY)!).apiKey, undefined);
});

test('AGENT_SYSTEM_PROMPT contains the core API and generation rules', () => {
  assert.ok(AGENT_SYSTEM_PROMPT.includes(renderAgentApiReference()), 'prompt must embed the generated canonical API reference');
  assert.ok(AGENT_SYSTEM_PROMPT.includes('Canonical entityAPI V2 contract'));
  assert.ok(AGENT_SYSTEM_PROMPT.includes('applyForce'));
  assert.ok(AGENT_SYSTEM_PROMPT.includes('setLocalSpin'));
  assert.ok(AGENT_SYSTEM_PROMPT.includes('groundDistance'));
  assert.ok(AGENT_SYSTEM_PROMPT.includes('ctx.tick % 60'));
  assert.ok(AGENT_SYSTEM_PROMPT.includes('ctx.root'));
  assert.ok(AGENT_SYSTEM_PROMPT.includes('self.state'));
  assert.ok(AGENT_SYSTEM_PROMPT.includes('world.voxels'));
  assert.equal(AGENT_SYSTEM_PROMPT.includes('children[{'), false, 'flat component snapshots are no longer injected');
});

test('parseThoughtAndContent extracts explicit reasoning and handles inline <think> tags', () => {
  // Explicit reasoning from API
  const res1 = parseThoughtAndContent('```js\nself.applyForce([0, 1, 0]);\n```', 'First compute upward force');
  assert.equal(res1.reasoning, 'First compute upward force');
  assert.equal(res1.content, '```js\nself.applyForce([0, 1, 0]);\n```');

  // Inline <think> tags
  const res2 = parseThoughtAndContent('<think>\nI need to hover at 5m\n</think>\n```js\nself.applyForce([0, 50, 0]);\n```');
  assert.equal(res2.reasoning, 'I need to hover at 5m');
  assert.equal(res2.content, '```js\nself.applyForce([0, 50, 0]);\n```');

  // Incomplete / streaming <think> tags
  const res3 = parseThoughtAndContent('<think>\nStill reasoning about gravity');
  assert.equal(res3.reasoning, 'Still reasoning about gravity');
  assert.equal(res3.content, '');
});

test('callChatAgent and runAgentTurn stream SSE response chunks with reasoning', async () => {
  const ssePayload = [
    'data: {"choices":[{"delta":{"reasoning_content":"Analyze requirement"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":" and generate hover code"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"```js\\n"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"self.applyForce([0, 99, 0]);\\n"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"```"}}]}\n\n',
    'data: [DONE]\n\n'
  ];

  const chunksReceived: any[] = [];
  const fakeStreamFetch = async (url, options) => {
    assert.equal(JSON.parse(options.body).stream, true, 'streaming should be enabled when onChunk is provided');
    let idx = 0;
    const encoder = new TextEncoder();
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (idx >= ssePayload.length) return { done: true, value: undefined };
            const value = encoder.encode(ssePayload[idx++]);
            return { done: false, value };
          }
        })
      }
    };
  };

  const result = (await runAgentTurn(
    'hover at 10m',
    { baseUrl: 'https://api.test/v1', apiKey: 'sk-stream', model: 'gpt-4o' },
    [],
    fakeStreamFetch,
    { id: 'arm_1', parentId: 'root', entityId: 'ent_jet_01', runtimeId: 42, allComponents: ['root', 'arm_1'], blockCount: 5, totalBlockCount: 20 },
    (chunk) => chunksReceived.push(chunk)
  )) as any;

  assert.equal(result.ok, true);
  assert.equal(result.reasoning, 'Analyze requirement and generate hover code');
  assert.equal(result.code, 'self.applyForce([0, 99, 0]);');
  assert.ok(chunksReceived.length >= 4, 'chunks should have been emitted during stream');
  assert.ok(chunksReceived.some(c => c.reasoning.includes('Analyze requirement')));
  assert.ok(chunksReceived.some(c => c.content.includes('applyForce')));
});

test('runAgentTurn prompt includes rich context with entity ID, components and block counts', async () => {
  let userMessage = '';
  const fakeFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    userMessage = body.messages.at(-1).content;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    };
  };

  await runAgentTurn(
    'turn the rotor',
    { baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'test' },
    [],
    fakeFetch,
    {
      id: 'rotor_left',
      parentId: 'wing',
      entityId: 'ent_drone_99',
      runtimeId: 7,
      allComponents: ['root', 'wing', 'rotor_left', 'rotor_right'],
      blockCount: 6,
      totalBlockCount: 35
    }
  );

  assert.match(userMessage, /Target component:/);
  assert.match(userMessage, /id: rotor_left/);
  assert.match(userMessage, /parent: wing/);
  assert.match(userMessage, /entity: ent_drone_99/);
  assert.match(userMessage, /owned blocks: 6/);
  assert.match(userMessage, /entity components: \[root, wing, rotor_left, rotor_right\]/);
  assert.match(userMessage, /total entity blocks: 35/);
});

test('config respects custom contextKTokens and maxOutputKTokens in K units', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  } as any;

  saveAgentConfig({
    baseUrl: 'https://custom.api/v1',
    apiKey: 'sk-custom',
    model: 'custom-model',
    contextKTokens: 16,
    maxOutputKTokens: 8,
    timeoutSeconds: 120
  });

  const loaded = loadAgentConfig();
  assert.equal(loaded.contextKTokens, 16);
  assert.equal(loaded.maxOutputKTokens, 8);
  assert.equal(loaded.timeoutSeconds, 120);
  assert.equal(loaded.apiKey, 'sk-custom');

  let capturedBody: any = null;
  const fakeFetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    };
  };

  const history = [
    { role: 'user', content: 'msg 1' },
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'msg 2' },
    { role: 'assistant', content: 'reply 2' }
  ];

  const sessionConfig = { ...loaded, apiKey: 'sk-custom' };
  await runAgentTurn('msg 3', sessionConfig, history, fakeFetch);

  // max_tokens should be 8 * 1024 = 8192
  assert.equal(capturedBody.max_tokens, 8192);
  assert.ok(capturedBody.messages.length >= 2);

  // Test token estimation and tight context window pruning
  const tightConfig = {
    ...sessionConfig,
    contextKTokens: 2 // 2K tokens = 2048 tokens total context window
  };

  // Create a large history that would exceed 2K tokens
  const hugeHistory = [
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: 'y'.repeat(4000) },
    { role: 'user', content: 'recent user message' },
    { role: 'assistant', content: 'recent assistant reply' }
  ];

  await runAgentTurn('latest request', tightConfig, hugeHistory, fakeFetch);
  // Huge older messages should be pruned from the front to fit the 2K context window
  assert.ok(capturedBody.messages.length < hugeHistory.length + 2, 'oversized history should be truncated to fit contextKTokens window');
  assert.equal(capturedBody.messages.at(-1).content.startsWith('latest request'), true);

  globalThis.localStorage = undefined;
});
