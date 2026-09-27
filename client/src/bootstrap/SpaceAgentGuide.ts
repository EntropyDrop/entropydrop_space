export function spaceAgentConnection(apiOrigin: string) {
  const origin = new URL(apiOrigin).origin;
  return {
    origin,
    skillUrl: `${origin}/space/agent/SKILL.md`,
    spaceApiUrl: `${origin}/space/agent/spaceAPI.md`,
    entityApiUrl: `${origin}/space/agent/entityAPI.md`,
    positionUrl: `${origin}/space/api/v2/players/me/position`,
  };
}

export function spaceAgentPrompt(apiOrigin: string): string {
  const { origin, skillUrl } = spaceAgentConnection(apiOrigin);
  return `Please read ${skillUrl} (Backend URL: ${origin}).\nFollow the skill guide to connect through browser authorization: start a pairing request, show me the authorization link and matching code, and wait for me to approve it. Retrieve the spaceAPI key yourself without asking me to copy a key. Reuse an existing authorized connection when available. Then help me build in EntropyDrop Space. Keep credentials private.`;
}
