import React from 'react';
import { spaceAgentConnection, spaceAgentPrompt } from '../../../bootstrap/SpaceAgentGuide.ts';
import { resolveApiOrigin } from '../../../bootstrap/SpaceBootstrap.ts';
import { spaceUiStore } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';

export function SpaceAgentInstructions() {
  const worldId = useSpaceUi(state => state.apiWorldId);
  const worldSlug = useSpaceUi(state => state.contraptions?.worldSlug);
  const worldName = useSpaceUi(state => state.contraptions?.worldName);
  const worldSelector = worldId || worldSlug || 'default';
  const connection = spaceUiStore.getApiKeyClient()?.getAgentConnection(worldSelector) || spaceAgentConnection(
    resolveApiOrigin(import.meta.env.VITE_SPACE_API_BASE_URL || import.meta.env.VITE_API_BASE_URL, window.location.origin),
    worldSelector,
  );
  const prompt = spaceAgentPrompt(connection.origin, connection.worldSelector);
  const [message, setMessage] = React.useState('');
  return <section className="settings-agent-guide" aria-labelledby="settings-agent-guide-title">
    <div className="settings-section-title" id="settings-agent-guide-title">Build nearby with an external agent</div>
    <p>Copy the prompt below to your agent (e.g. Claude, Cursor). Open the link it provides, check the matching code, and approve the connection. Your agent receives a key automatically and can start building.</p>
    <p>Agents send HTTP requests through spaceAPI. Entity code calls entityAPI (self / ctx) inside the runtime. Both public documents link to each other.</p>
    <dl>
      <div><dt>Backend URL</dt><dd><code>{connection.origin}</code></dd></div>
      <div><dt>Target world</dt><dd>{worldName || connection.worldSelector}</dd></div>
      <div><dt>spaceAPI · Agent HTTP requests</dt><dd><a href={connection.spaceApiUrl} target="_blank" rel="noopener noreferrer">{connection.spaceApiUrl}</a></dd></div>
      <div><dt>entityAPI · Entity code</dt><dd><a href={connection.entityApiUrl} target="_blank" rel="noopener noreferrer">{connection.entityApiUrl}</a></dd></div>
      <div><dt>Agent Skill</dt><dd><a href={connection.skillUrl} target="_blank" rel="noopener noreferrer">{connection.skillUrl}</a></dd></div>
      <div><dt>Own position · key required</dt><dd><code>GET /space/api/v2/players/me/position?world={connection.worldSelector}</code></dd></div>
    </dl>
    <p>The copied prompt targets this world. Agents can discover Aether Archipelago, Nature, Copper Metropolis and other worlds available on this backend, then join the requested world and build there. The guide needs no login; world discovery, position and build requests need a Bearer API key. Positions older than 30 seconds are marked stale. All API keys, including existing keys, have full Space permissions to create, edit, start/stop entities and build blocksets. No permission selection is needed. Stop before editing and keep your browser online for execution. A localhost address works only for an agent on the same machine.</p>
    <details>
      <summary>View an example prompt for your agent</summary>
      <pre>{prompt}</pre>
    </details>
    <button className="small-btn" onClick={() => {
      if (!navigator.clipboard?.writeText) {
        setMessage('Expand the example and copy it manually.');
        return;
      }
      void navigator.clipboard.writeText(prompt).then(
        () => setMessage('Copied. Send directly to your agent.'),
        () => setMessage('Copy failed. Expand the example and copy it manually.'),
      );
    }}>Copy Agent Prompt</button>
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
