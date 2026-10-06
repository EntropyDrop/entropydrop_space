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
          <li>Open the authorization link your agent provides, check the matching code, and approve the connection.</li>
          <li>Describe what to build and where in the selected world. Keep Space open to run browser-executed entities.</li>
        </ol>
        <p className="settings-desc">Your agent receives its own key automatically after approval. A spaceAPI key grants full Space access. Only approve an agent you trust; you can revoke it here at any time. This is not a model API key.</p>
        <SpaceApiKeysSettings />
      </div>
    </div>
  );
}
