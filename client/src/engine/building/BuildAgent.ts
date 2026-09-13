import {
  callChatAgent,
  DEFAULT_AGENT_CONTEXT_K_TOKENS,
  estimateTokens
} from '../contraption/AgentChat.ts';
import type { SpaceBuildPlanInput } from './SpaceBuilder.ts';

export const BUILD_AGENT_SYSTEM_PROMPT = `You are the construction-planning assistant for the Space voxel world.
Convert the player's request into exactly one JSON object and output no prose or Markdown.

Schema:
{
  "version": 1,
  "kind": "structure" | "entity",
  "name": "short name",
  "anchor": "crosshair",
  "blocks": [{"x":0,"y":0,"z":0,"size":1,"color":"#f2a93b","componentId":"body"}],
  "primitives": [
    {"type":"box","from":[0,0,0],"to":[6,4,6],"hollow":true,"size":1,"color":"#f2a93b","componentId":"body"},
    {"type":"line","from":[0,0,0],"to":[0,5,0],"size":1,"color":"#48dbfb","componentId":"body"}
  ],
  "components": [{"id":"body","parentId":null,"bodyType":"dynamic","useGravity":true}],
  "constraints": [],
  "bodyType":"dynamic",
  "useGravity":true,
  "collisionEnabled":true
}

Rules:
- Coordinates are local offsets from the placement anchor; Y is up. Standard voxels use integer coordinates and size 1. Micro voxels use 0.125-grid coordinates and size 0.125.
- Prefer compact box/line primitives over enumerating many blocks. Use hollow boxes for shells and several boxes when doors/windows need openings.
- Use only color block material. Colors are #RRGGBB.
- Keep each axis within 64 metres and the expanded result within 65,536 voxels.
- A structure becomes terrain. An entity becomes an independent physics object.
- Entity component ids are unique identifiers with no reserved values. Exactly one component has parentId null; that structural root may use any id. Every other component names an existing parentId.
- In constraints, bodyA null means the external world anchor; every string in bodyA/bodyB is always a component id.
- Only add components, constraints, seats, or scripts when the player explicitly requests an articulated or programmable entity.
- Never include delete, replace, HTTP, text-chat, audio, filesystem, or arbitrary code-execution instructions.
- If revising a previous plan, return the complete replacement plan, not a patch.`;

function jsonCandidate(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenced) return fenced[1].trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  return start >= 0 && end > start ? content.slice(start, end + 1) : null;
}

export function extractSpaceBuildPlan(content: string): SpaceBuildPlanInput | null {
  if (!content || content.length > 2 * 1024 * 1024) return null;
  const candidate = jsonCandidate(content);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function runSpaceBuildAgentTurn(
  userPrompt: string,
  config: any,
  history: Array<{ role: string; content: string }> = [],
  context: any = null,
  fetchImpl: any = null,
  onChunk: any = null
) {
  const prompt = String(userPrompt || '').trim();
  if (!prompt) return { ok: false, error: 'Describe the structure or entity you want to build.' };
  if (!config?.apiKey) {
    return { ok: false, error: 'Configure a model API key in Setup before generating a build plan.' };
  }

  let contextNote = '';
  if (context) {
    try {
      let encoded = JSON.stringify(context);
      if (encoded.length > 128 * 1024) {
        encoded = JSON.stringify({
          ...context,
          previousPlan: null,
          previousPlanOmitted: 'Previous expanded plan was too large; create a complete replacement from the conversation.'
        });
      }
      contextNote = `\n\nCurrent placement context:\n${encoded}`;
    } catch {
      contextNote = '';
    }
  }
  const contextK = Number.isFinite(Number(config.contextKTokens))
    ? Math.max(1, Number(config.contextKTokens))
    : DEFAULT_AGENT_CONTEXT_K_TOKENS;
  const budget = Math.round(contextK * 1024);
  const baseTokens = estimateTokens(BUILD_AGENT_SYSTEM_PROMPT) + estimateTokens(prompt + contextNote) + 64;
  const historyBudget = Math.max(0, budget - baseTokens);
  const selectedHistory: Array<{ role: string; content: string }> = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    const cost = estimateTokens(message.content) + 4;
    if (used + cost > historyBudget) break;
    selectedHistory.unshift({ role: message.role, content: message.content });
    used += cost;
  }

  const response = await callChatAgent([
    { role: 'system', content: BUILD_AGENT_SYSTEM_PROMPT },
    ...selectedHistory,
    { role: 'user', content: `${prompt}${contextNote}` }
  ], config, fetchImpl, onChunk);
  if (!response.ok) return response;
  const plan = extractSpaceBuildPlan(response.content || '');
  if (!plan) {
    return {
      ok: false,
      error: 'The model did not return a valid JSON BuildPlan. Try the request again.',
      content: response.content,
      reasoning: response.reasoning
    };
  }
  return {
    ok: true,
    content: response.content,
    reasoning: response.reasoning || '',
    plan
  };
}
