export const spaceAgentOnboarding = {
  title: 'Agent Build',
  description: 'Build structures and entities with your external agent.',
  steps: [
    'Copy the prompt to your agent.',
    'Open its authorization link, check the code, and approve.',
    'Tell your agent what to build. Keep Space open to run entities in your browser.',
  ],
  note: 'Authorization grants full Space access. Only approve agents you trust; revoke access in API Keys. No model API key is needed here.',
  targetWorld: 'Target world',
  backend: 'Backend URL',
  guide: 'spaceAPI',
  entityGuide: 'entityAPI',
  copy: 'Copy Agent Prompt',
  copied: 'Copied. Send it to your agent.',
  copyFailed: 'Copy failed. Expand the prompt and copy it manually.',
  example: 'View prompt & docs',
} as const;

export function spaceAgentConnection(apiOrigin: string, worldSelector?: string | null) {
  const origin = new URL(apiOrigin).origin;
  const world = worldSelector?.trim() || 'default';
  return {
    origin,
    worldSelector: world,
    worldsUrl: `${origin}/space/api/v2/worlds`,
    skillUrl: `${origin}/space/agent/SKILL.md`,
    spaceApiUrl: `${origin}/space/agent/spaceAPI.md`,
    entityApiUrl: `${origin}/space/agent/entityAPI.md`,
    positionUrl: `${origin}/space/api/v2/players/me/position?world=${encodeURIComponent(world)}`,
  };
}

export function spaceAgentPrompt(apiOrigin: string, worldSelector?: string | null): string {
  const { skillUrl, worldSelector: world } = spaceAgentConnection(apiOrigin, worldSelector);
  return `Read ${skillUrl}.\nTarget world: ${JSON.stringify(world)}. Resolve its ID through GET /space/api/v2/worlds and use that same ID for all requests. Join if needed. Do not use another world's position or fall back to Nature.\nConnect through browser authorization: show me the link and code, wait for me to approve, and retrieve the key yourself without asking me to copy a key. Reuse an existing authorized connection when available. Help me build in this world. Keep credentials private.`;
}
