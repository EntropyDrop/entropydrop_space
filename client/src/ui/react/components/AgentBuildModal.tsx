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
        <SpaceApiKeysSettings />
      </div>
    </div>
  );
}
