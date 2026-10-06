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
  const { origin, skillUrl, worldSelector: world } = spaceAgentConnection(apiOrigin, worldSelector);
  return `Please read ${skillUrl} (Backend URL: ${origin}).\nTarget world: ${JSON.stringify(world)}. Discover it through GET /space/api/v2/worlds, resolve its canonical world ID, and use that same ID for position, entity, blockset and configuration requests. Join this world through POST /space/api/v2/worlds/{world}/join if needed. Do not use another world's saved position or silently fall back to Nature.\nFollow the skill guide to connect through browser authorization: start a pairing request, show me the authorization link and matching code, and wait for me to approve it. Retrieve the spaceAPI key yourself without asking me to copy a key. Reuse an existing authorized connection when available. Then help me build in the selected EntropyDrop Space world. Keep credentials private.`;
}
