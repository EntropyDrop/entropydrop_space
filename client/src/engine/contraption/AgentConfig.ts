export interface AgentConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextKTokens: number;
  maxOutputKTokens: number;
  timeoutSeconds: number;
  rememberApiKey: boolean;
}

type AgentConfigInput = Partial<Record<keyof AgentConfig, unknown>> & {
  contextLength?: unknown;
  maxTokens?: unknown;
};

type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const AGENT_CONFIG_STORAGE_KEY = 'space.agent.config.v1';
export const AGENT_SESSION_KEY_STORAGE_KEY = 'space.agent.api-key.session.v1';
export const DEFAULT_AGENT_CONTEXT_K_TOKENS = 256;
export const DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS = 128;

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  contextKTokens: DEFAULT_AGENT_CONTEXT_K_TOKENS,
  maxOutputKTokens: DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS,
  timeoutSeconds: 60,
  rememberApiKey: false,
};

// Storage can be unavailable in privacy modes and in the Node test runtime.
// This fallback keeps a key usable for the lifetime of the current document
// without silently promoting it to persistent storage.
let inMemorySessionApiKey = '';

function browserStorage(name: 'localStorage' | 'sessionStorage'): BrowserStorage | null {
  try {
    const storage = globalThis[name] as BrowserStorage | undefined;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, numeric)) : fallback;
}

export function normalizeAgentConfig(config: AgentConfigInput = {}): AgentConfig {
  const legacyContext = Number(config.contextLength);
  const legacyMaxTokens = Number(config.maxTokens);
  return {
    baseUrl: String(config.baseUrl || DEFAULT_AGENT_CONFIG.baseUrl).trim() || DEFAULT_AGENT_CONFIG.baseUrl,
    apiKey: String(config.apiKey || '').trim(),
    model: String(config.model || DEFAULT_AGENT_CONFIG.model).trim() || DEFAULT_AGENT_CONFIG.model,
    contextKTokens: boundedNumber(
      config.contextKTokens ?? (Number.isFinite(legacyContext) ? legacyContext : undefined),
      DEFAULT_AGENT_CONTEXT_K_TOKENS,
      1,
      2048,
    ),
    maxOutputKTokens: boundedNumber(
      config.maxOutputKTokens ?? (Number.isFinite(legacyMaxTokens) ? legacyMaxTokens / 1024 : undefined),
      DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS,
      0.1,
      128,
    ),
    timeoutSeconds: boundedNumber(config.timeoutSeconds, DEFAULT_AGENT_CONFIG.timeoutSeconds, 5, 600),
    rememberApiKey: config.rememberApiKey === true,
  };
}

function persistentPreferences(config: AgentConfig): Omit<AgentConfig, 'apiKey'> & { apiKey?: string } {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    contextKTokens: config.contextKTokens,
    maxOutputKTokens: config.maxOutputKTokens,
    timeoutSeconds: config.timeoutSeconds,
    rememberApiKey: config.rememberApiKey,
    ...(config.rememberApiKey && config.apiKey ? { apiKey: config.apiKey } : {}),
  };
}

function writeSessionKey(apiKey: string): void {
  inMemorySessionApiKey = apiKey;
  const storage = browserStorage('sessionStorage');
  if (!storage) return;
  try {
    if (apiKey) storage.setItem(AGENT_SESSION_KEY_STORAGE_KEY, apiKey);
    else storage.removeItem(AGENT_SESSION_KEY_STORAGE_KEY);
  } catch {
    // The in-memory fallback remains available for this document.
  }
}

/**
 * Load non-secret preferences from localStorage and the default session-only
 * API key from sessionStorage. Legacy configurations containing a raw key are
 * migrated out of localStorage while keeping the key alive for this tab.
 */
export function loadAgentConfig(): AgentConfig {
  const persistentStorage = browserStorage('localStorage');
  let parsed: AgentConfigInput = {};
  try {
    const raw = persistentStorage?.getItem(AGENT_CONFIG_STORAGE_KEY);
    if (raw) parsed = JSON.parse(raw) as AgentConfigInput;
  } catch {
    parsed = {};
  }

  const legacyPersistentKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
  const explicitlyRemembered = parsed.rememberApiKey === true;
  let sessionKey = '';
  try {
    sessionKey = browserStorage('sessionStorage')?.getItem(AGENT_SESSION_KEY_STORAGE_KEY)?.trim() || '';
  } catch {
    sessionKey = '';
  }

  const config = normalizeAgentConfig({
    ...parsed,
    apiKey: sessionKey || inMemorySessionApiKey || legacyPersistentKey,
    rememberApiKey: explicitlyRemembered,
  });

  if (legacyPersistentKey && !explicitlyRemembered) {
    writeSessionKey(legacyPersistentKey);
    try {
      persistentStorage?.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(persistentPreferences(config)));
    } catch {
      // A failed migration is non-fatal; the UI still exposes the risk.
    }
  }
  return config;
}

/** Save the key for this tab by default, or persist it only after explicit opt-in. */
export function saveAgentConfig(input: AgentConfigInput): boolean {
  const config = normalizeAgentConfig(input);
  writeSessionKey(config.apiKey);
  try {
    const storage = browserStorage('localStorage');
    if (!storage) return false;
    storage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(persistentPreferences(config)));
    return true;
  } catch {
    return false;
  }
}
