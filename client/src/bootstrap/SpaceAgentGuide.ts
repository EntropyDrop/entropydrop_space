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

export function spaceAgentPrompt(apiOrigin: string, zh = false): string {
  const { origin, skillUrl } = spaceAgentConnection(apiOrigin);
  return zh
    ? `请先阅读 ${skillUrl}（后端地址：${origin}）。\n请根据技能规范，向我索取 spaceAPI Key 与建造需求，并在 EntropyDrop Space 中完成建造。`
    : `Please read ${skillUrl} (Backend URL: ${origin}).\nFollow the skill guide to ask me for my spaceAPI key and build request, and build it in EntropyDrop Space.`;
}
