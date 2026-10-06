import React from 'react';
import { spaceAgentConnection, spaceAgentOnboarding, spaceAgentPrompt } from '../../../bootstrap/SpaceAgentGuide.ts';
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
  const text = spaceAgentOnboarding;
  const [message, setMessage] = React.useState('');
  return <section className="settings-agent-guide" aria-labelledby="settings-agent-guide-title">
    <div className="settings-section-title" id="settings-agent-guide-title">{text.title}</div>
    <p>{text.description}</p>
    <ol className="agent-build-steps">{text.steps.map(step => <li key={step}>{step}</li>)}</ol>
    <p>{text.targetWorld}: <strong>{worldName || connection.worldSelector}</strong></p>
    <button type="button" className="small-btn" onClick={() => {
      if (!navigator.clipboard?.writeText) {
        setMessage(text.copyFailed);
        return;
      }
      void navigator.clipboard.writeText(prompt).then(
        () => setMessage(text.copied),
        () => setMessage(text.copyFailed),
      );
    }}>{text.copy}</button>
    {message ? <p role="status">{message}</p> : null}
    <p className="settings-desc">{text.note}</p>
    <details>
      <summary>{text.example}</summary>
      <pre>{prompt}</pre>
      <p>{text.backend}: <code>{connection.origin}</code></p>
      <div className="settings-agent-links">
        <a href={connection.spaceApiUrl} target="_blank" rel="noopener noreferrer">{text.guide}</a>
        <a href={connection.entityApiUrl} target="_blank" rel="noopener noreferrer">{text.entityGuide}</a>
        <a href={connection.skillUrl} target="_blank" rel="noopener noreferrer">Agent Skill</a>
      </div>
    </details>
  </section>;
}
