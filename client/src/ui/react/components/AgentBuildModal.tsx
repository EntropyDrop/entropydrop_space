import React from 'react';
import { SpaceApiKeysSettings } from './SimpleModals.tsx';
import { spaceUiStore } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';

export function AgentBuildModal() {
  const open = useSpaceUi(state => state.activeModal === 'agent-build');
  if (!open) return null;
  return (
    <div id="agent-build-modal" className="custom-modal open" onMouseDown={event => {
      if (event.target === event.currentTarget) spaceUiStore.toggleAgentBuild(false);
    }}>
      <div className="modal-content agent-build-modal-content" role="dialog" aria-modal="true" aria-labelledby="agent-build-title">
        <div className="modal-header">
          <h2 id="agent-build-title">AGENT BUILD</h2>
          <button type="button" tabIndex={-1} className="icon-btn" aria-label="Close Agent Build" title="Close Agent Build (ESC)" onClick={() => spaceUiStore.toggleAgentBuild(false)}>✕</button>
        </div>
        <p className="modal-sub">Use your external agent to build structures and entities through spaceAPI.</p>
        <ol className="agent-build-steps">
          <li>Copy the Agent Prompt below to your agent.</li>
          <li>Create a spaceAPI key or use an existing key, then give it to your trusted agent when asked.</li>
          <li>Describe what to build. Keep Space open so the agent can locate you and run browser-executed entities.</li>
        </ol>
        <p className="settings-desc">A spaceAPI key grants full Space access. Share it only with an agent you trust, and revoke it here when no longer needed. This is not a model API key.</p>
        <SpaceApiKeysSettings />
      </div>
    </div>
  );
}
