import { compileBehaviorPrompt } from './BehaviorAgent.ts';
import { renderAgentApiReference } from '@entropydrop/space-engine/contraption/ScriptApiContract.ts';
import {
  DEFAULT_AGENT_CONTEXT_K_TOKENS,
  DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS,
} from './AgentConfig.ts';
import {
  isLocalDevelopmentHost,
  readJsonResponse,
} from '../../bootstrap/NetworkSafety.ts';

export {
  AGENT_CONFIG_STORAGE_KEY,
  AGENT_SESSION_KEY_STORAGE_KEY,
  DEFAULT_AGENT_CONTEXT_K_TOKENS,
  DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS,
  loadAgentConfig,
  saveAgentConfig,
} from './AgentConfig.ts';
export { isLocalDevelopmentHost } from '../../bootstrap/NetworkSafety.ts';

/**
 * Agent chat module.
 *
 * API facts are rendered from ScriptApiContract.ts. This file owns only model
 * role/output policy and transport; the in-game reference and entityAPI code-generation
 * docs consume the same contract.
 */
const AGENT_ROLE = `You are the component programming assistant for the "Space" voxel-physics world. Generate an entityAPI V2 controller from the player's natural-language request. entityAPI runs inside entity code with self and ctx; spaceAPI is the separate HTTP interface for Agent requests.`;

const AGENT_GENERATION_RULES = `## Generation rules
1. Output exactly one JavaScript code block wrapped in \`\`\`js and no prose outside it.
2. Use only the canonical APIs above. Use self.state for cross-tick values. Use ctx.deltaTime only when explicitly integrating a rate; forces and torques are already per-update commands and must not be multiplied by deltaTime.
3. Never use unbounded loops. Avoid expensive full-tree traversal and cache known component ids when appropriate.
4. Hover: lift = mass*abs(gravityY) + heightError*Kp - verticalVelocity*Kd, plus attitude torque.
5. Stabilize with torque from attitude error and angular-velocity damping.
6. Mounted rotors use setLocalSpin for visuals and applyLocalThrust([0,thrust,0]) so thrust follows each component's installed anchor frame; yaw uses root torque.
7. Check ctx.players.length before following a player.
8. Throttle logs, e.g. if (ctx.tick % 60 === 0) ctx.log(...).
9. Respect the provisional queued-mutation semantics and command-limit behavior stated in the canonical contract.
10. Follow/orbit/seek across a torus seam with the wrapped shortest-distance formula from the canonical contract, never raw X/Z differences.
11. Player-relative vertical offsets start from the documented eye position, not feet.
12. Gate destructive selection commands with self.state or an input edge; never call delete/assemble/createChild unconditionally every tick.`;

export const AGENT_SYSTEM_PROMPT = [
  AGENT_ROLE,
  renderAgentApiReference(),
  AGENT_GENERATION_RULES
].join('\n\n');

const MAX_AGENT_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_RESPONSE_CHARS = 2 * 1024 * 1024;
const MAX_AGENT_MODELS = 1000;

async function readAgentJson(response: any): Promise<any> {
  if (typeof response?.arrayBuffer === 'function') {
    return readJsonResponse(response, MAX_AGENT_JSON_RESPONSE_BYTES);
  }
  // Small injected test adapters may implement only the fetch methods used by
  // the assertion. Production browser fetch always takes the bounded path.
  return response?.json?.();
}

/**
 * Approximate token count for text. Roughly ~3.5 chars per token for code/English text.
 */
export function estimateTokens(text = ''): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.5));
}

function resolveAgentEndpoint(baseUrl, path): any {
  const endpoint = `${String(baseUrl || '').trim().replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch (_) {
    return { ok: false, error: 'Agent API base URL is invalid.' };
  }
  const localDevelopmentHost = isLocalDevelopmentHost(endpointUrl.hostname);
  if (endpointUrl.protocol !== 'https:' && !(endpointUrl.protocol === 'http:' && localDevelopmentHost)) {
    return { ok: false, error: 'Agent API keys may only be sent to HTTPS endpoints (HTTP is allowed only on localhost and local network IPs).' };
  }
  return { ok: true, url: endpointUrl.toString() };
}

/**
 * Fetch the model catalog exposed by an OpenAI-compatible API base URL.
 * API keys are restored from session storage (or explicit persistent opt-in)
 * and sent only to HTTPS or localhost.
 *
 * Besides the canonical `{ data: [{ id }] }` response, accept a raw array and
 * `{ models: [...] }` for small local OpenAI-compatible servers.
 */
export async function fetchAgentModels(config, fetchImpl = null) {
  const resolved = resolveAgentEndpoint(config?.baseUrl, 'models');
  if (!resolved.ok) return resolved;

  const fetcher = fetchImpl || ((url, opts) => fetch(url, opts));
  const timeoutMs = Math.max(1000, Math.min(120000,
    Number(config?.timeoutSeconds) > 0
      ? Number(config?.timeoutSeconds) * 1000
      : (Number(config?.timeoutMs) || 15000)
  ));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers: any = { Accept: 'application/json' };
  const apiKey = String(config?.apiKey || '').trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetcher(resolved.url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = typeof response.text === 'function'
        ? await response.text().catch(() => '')
        : '';
      return {
        ok: false,
        error: `Model list request failed (HTTP ${response.status}): ${detail.slice(0, 200)}`
      };
    }

    const payload = await readAgentJson(response);
    const entries = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.data) ? payload.data : payload?.models);
    if (!Array.isArray(entries)) {
      return { ok: false, error: 'Model list response is missing a data array.' };
    }

    const models = [];
    const seen = new Set();
    for (const entry of entries.slice(0, MAX_AGENT_MODELS)) {
      const id = typeof entry === 'string'
        ? entry.trim()
        : String(entry?.id || entry?.name || entry?.model || '').trim();
      if (!id || id.length > 256 || seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }
    if (models.length === 0) {
      return { ok: false, error: 'The API returned no available models.' };
    }
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? `Model list request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        : `Model list request failed: ${err?.message || String(err)}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract the first ```js code block from a model reply; returns null when no
 * code block is present.
 */
export function extractCodeBlock(content, options: any = {}) {
  if (!content) return null;
  const match = content.match(/```(?:js|javascript)?\s*\n([\s\S]*?)\n```/i);
  if (match) return match[1].trim();
  if (options.allowUnfenced === false) return null;
  // Fallback: when there are no fences, return the whole content if it looks
  // like JS (mentions the V2 self/ctx APIs) and is not a plain-text answer.
  if (/(self\.|ctx\.)/.test(content) && !/^\s*[\[#]/.test(content)) {
    return content.trim();
  }
  return null;
}

/**
 * Extract reasoning / thought chain and final answer content from raw output,
 * supporting both explicit API reasoning and inline <think> tags.
 */
export function parseThoughtAndContent(rawContent = '', explicitReasoning = '') {
  let reasoning = explicitReasoning || '';
  let content = rawContent || '';

  if (content.includes('<think>')) {
    const thinkMatch = content.match(/<think>([\s\S]*?)(?:<\/think>|$)([\s\S]*)$/i);
    if (thinkMatch) {
      const embeddedThought = thinkMatch[1].trim();
      if (!reasoning) {
        reasoning = embeddedThought;
      } else if (embeddedThought && !reasoning.includes(embeddedThought)) {
        reasoning = `${reasoning}\n${embeddedThought}`.trim();
      }
      content = thinkMatch[2] ? thinkMatch[2].trimStart() : '';
    }
  }
  return { reasoning: reasoning.trim(), content };
}

/**
 * Call an OpenAI-compatible Chat Completions endpoint with optional SSE streaming.
 * @returns {Promise<{ok: boolean, content?: string, reasoning?: string, error?: string}>}
 */
export async function callChatAgent(messages, config, fetchImpl = null, onChunk = null) {
  const fetcher = fetchImpl || ((url, opts) => fetch(url, opts));
  const resolved = resolveAgentEndpoint(config?.baseUrl, 'chat/completions');
  if (!resolved.ok) return resolved;
  const stream = typeof onChunk === 'function';
  const maxTokensK = Number.isFinite(config?.maxOutputKTokens) && config.maxOutputKTokens > 0
    ? config.maxOutputKTokens
    : (Number.isFinite(config?.maxTokens) && config.maxTokens > 0
      ? config.maxTokens / 1024
      : DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS);
  const maxTokens = Math.max(64, Math.round(maxTokensK * 1024));
  const timeoutMs = Math.max(1000, Math.min(600000,
    Number(config?.timeoutSeconds) > 0
      ? Number(config?.timeoutSeconds) * 1000
      : (Number(config?.timeoutMs) || 60000)
  ));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(resolved.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.4,
        max_tokens: maxTokens,
        ...(stream ? { stream: true } : {})
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        error: `API request failed (HTTP ${response.status}): ${detail.slice(0, 200)}`
      };
    }

    // Stream reader if the response body supports SSE streaming
    if (stream && response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let rawContent = '';
      let rawReasoning = '';
      let finishReason = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length + rawContent.length + rawReasoning.length > MAX_AGENT_RESPONSE_CHARS) {
          await reader.cancel?.().catch?.(() => undefined);
          return { ok: false, error: 'Agent response exceeded the 2 MiB safety limit.' };
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const choice = data?.choices?.[0];
              if (choice?.finish_reason) finishReason = choice.finish_reason;
              const delta = choice?.delta;
              if (delta) {
                const cDelta = delta.content || '';
                const rDelta = delta.reasoning_content || delta.reasoning || delta.thought || '';
                if (cDelta) rawContent += cDelta;
                if (rDelta) rawReasoning += rDelta;
                if (rawContent.length + rawReasoning.length > MAX_AGENT_RESPONSE_CHARS) {
                  await reader.cancel?.().catch?.(() => undefined);
                  return { ok: false, error: 'Agent response exceeded the 2 MiB safety limit.' };
                }

                const parsed = parseThoughtAndContent(rawContent, rawReasoning);
                onChunk({
                  content: parsed.content,
                  reasoning: parsed.reasoning,
                  contentDelta: cDelta,
                  reasoningDelta: rDelta,
                  isStreaming: true
                });
              }
            } catch {
              // Ignore partial JSON parse errors
            }
          }
        }
      }

      const parsed = parseThoughtAndContent(rawContent, rawReasoning);
      return { ok: true, content: parsed.content, reasoning: parsed.reasoning };
    }

    // Fallback for non-streaming response or mocked responses
    const data = await readAgentJson(response);
    const choice = data?.choices?.[0];
    const rawContent = choice?.message?.content;
    if (typeof rawContent !== 'string') {
      return { ok: false, error: 'API response is missing choices[0].message.content' };
    }
    if (rawContent.length > MAX_AGENT_RESPONSE_CHARS) {
      return { ok: false, error: 'Agent response exceeded the 2 MiB safety limit.' };
    }
    const rawReasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || choice?.message?.thought || '';
    const parsed = parseThoughtAndContent(rawContent, rawReasoning);
    if (typeof onChunk === 'function') {
      onChunk({
        content: parsed.content,
        reasoning: parsed.reasoning,
        contentDelta: parsed.content,
        reasoningDelta: parsed.reasoning,
        isStreaming: false
      });
    }
    return { ok: true, content: parsed.content, reasoning: parsed.reasoning };
  } catch (err) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? `Agent request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        : `Network request failed: ${err?.message || String(err)}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run one agent chat turn.
 * With an API key → remote model (system prompt + message history);
 * without a key → local rule compiler.
 * @param {string} userPrompt player input
 * @param {{baseUrl:string, apiKey:string, model:string}} config
 * @param {Array<{role:string, content:string}>} history existing chat history (without the current input)
 * @returns {Promise<{ok: boolean, content?: string, reasoning?: string, code?: string|null, error?: string, local?: boolean}>}
 */
export async function runAgentTurn(
  userPrompt,
  config,
  history = [],
  fetchImpl = null,
  targetContext: any = null,
  onChunk: any = null
) {
  const prompt = String(userPrompt || '').trim();
  if (!prompt) return { ok: false, error: 'Please describe the behavior first, e.g. "hover 5 meters above the ground".' };

  // Local fallback: single-turn rule compilation
  if (!config || !config.apiKey) {
    const result = compileBehaviorPrompt(prompt);
    if (!result.ok) {
      return { ok: false, error: result.error, local: true };
    }
    const content = result.intent === 'stop'
      ? 'Active control stopped: the controller no longer applies forces or torques.'
      : `(local compiler) ${result.summary}`;
    const code = result.code || null;
    if (typeof onChunk === 'function') {
      onChunk({ content, reasoning: '', contentDelta: content, reasoningDelta: '', isStreaming: false });
    }
    return {
      ok: true,
      local: true,
      content,
      reasoning: '',
      code
    };
  }

  let targetNote = '';
  if (targetContext) {
    const entId = targetContext.entityId ?? (targetContext.runtimeId !== null ? `Entity #${targetContext.runtimeId}` : 'unknown');
    const compId = String(targetContext.id ?? '');
    const parentComp = targetContext.parentId ?? 'none';
    const compBlocks = Number(targetContext.blockCount) || 0;
    const totalBlocks = Number(targetContext.totalBlockCount) || compBlocks;
    const compList = Array.isArray(targetContext.allComponents) && targetContext.allComponents.length > 0
      ? targetContext.allComponents.join(', ')
      : compId;

    targetNote = `\n\nTarget component:\n- id: ${compId}\n- parent: ${parentComp}\n- entity: ${entId}\n- owned blocks: ${compBlocks}\n- entity components: [${compList}]\n- total entity blocks: ${totalBlocks}`;
  }

  const contextK = config && Number.isFinite(config.contextKTokens) && config.contextKTokens > 0
    ? config.contextKTokens
    : (config && Number.isFinite(config.contextLength) && config.contextLength > 0
      ? config.contextLength
      : DEFAULT_AGENT_CONTEXT_K_TOKENS);
  const totalContextTokens = Math.round(contextK * 1024);
  const systemTokens = estimateTokens(AGENT_SYSTEM_PROMPT);
  const userPromptTokens = estimateTokens(`${prompt}${targetNote}`);
  const baseOverhead = systemTokens + userPromptTokens + 64;
  const availableHistoryTokens = Math.max(0, totalContextTokens - baseOverhead);

  const historySlice: any[] = [];
  let accumulatedTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const itemTokens = estimateTokens(item.content) + 4;
    if (accumulatedTokens + itemTokens <= availableHistoryTokens) {
      historySlice.unshift(item);
      accumulatedTokens += itemTokens;
    } else {
      break;
    }
  }

  const messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...historySlice.map(item => ({ role: item.role, content: item.content })),
    { role: 'user', content: `${prompt}${targetNote}` }
  ];
  const response = await callChatAgent(messages, config, fetchImpl, onChunk);
  if (!response.ok) return response;
  return {
    ok: true,
    content: response.content,
    reasoning: response.reasoning || '',
    // Remote prose or unfenced snippets remain visible in chat but are never
    // auto-applied. The local deterministic compiler does not use this path.
    code: extractCodeBlock(response.content, { allowUnfenced: false })
  };
}
