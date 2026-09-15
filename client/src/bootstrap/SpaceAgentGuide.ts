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
  return `Please read ${skillUrl} (Backend URL: ${origin}).\nFollow the skill guide to ask me for my spaceAPI key and build request, and build it in EntropyDrop Space.`;
}
