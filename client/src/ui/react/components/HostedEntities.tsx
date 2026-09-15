import React, { useState } from 'react';
import { FaStop } from 'react-icons/fa';
import { LiaAngleDownSolid, LiaServerSolid, LiaSyncSolid, LiaMapMarkerSolid } from 'react-icons/lia';
import { spaceUiStore, hostingAvailabilityMessage } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';

export function HostedEntities() {
  const { hosting, hostingBusyIds, hostingError } = useSpaceUi(state => state);
  const [expanded, setExpanded] = useState(true);
  const running = hosting.items.filter(entity => entity.enabled).length;
  return <section className="hud-entities-section hud-hosting-section" id="hud-hosted-entities" aria-label="Hosted entities">
    <button type="button" tabIndex={-1} className="hud-entities-header hud-hosting-toggle" aria-expanded={expanded}
      title="Your server-hosted entities · includes entities outside the nearby area" onClick={() => setExpanded(value => !value)}>
      <span className="hud-entities-title"><LiaServerSolid size={14} aria-hidden="true" /> Hosted Entities ({running})</span>
      <LiaAngleDownSolid size={12} style={{ transform: expanded ? 'rotate(180deg)' : 'none' }} aria-hidden="true" />
    </button>
    {expanded && <div className="hud-entities-body">
      <div className="hud-hosting-capacity"><span>{hostingAvailabilityMessage(hosting)}</span>
        <button type="button" tabIndex={-1} className="hud-entity-nav-btn" aria-label="Refresh hosted entities" title="Refresh hosting status"
          onClick={() => void spaceUiStore.refreshHosting()}><LiaSyncSolid size={12} aria-hidden="true" /></button>
      </div>
      {hostingError && <div className="hud-hosting-error" role="status">{hostingError}</div>}
      <div className="hud-entities-list">
        {hosting.items.length === 0 ? <div className="hud-entity-empty">No server-hosted entities</div> : hosting.items.map(entity => {
          const busy = hostingBusyIds.includes(entity.entity_id);
          const state = entity.state === 'paused' ? 'Stopped' : entity.state === 'running' ? 'Running'
            : entity.state === 'starting' ? 'Starting' : 'Unavailable';
          return <div className="hud-entity-item" key={entity.entity_id}>
            <div className="hud-entity-info">
              <div className="hud-entity-name" title={entity.name}>{entity.name}</div>
              <div className="hud-entity-meta"><span>{state}</span>{entity.core_id !== null && <span>Core {entity.core_id + 1}</span>}</div>
              <div className="hud-entity-meta">{Math.ceil(entity.remaining_ms / 60_000)} min prepaid · budget {entity.budget_remaining_credits}</div>
              {(entity.error || entity.reason) && <div className="hud-hosting-error" title={entity.error || entity.reason || ''}>
                {(entity.error || entity.reason || '').replaceAll('_', ' ')}</div>}
            </div>
            <div className="hud-hosting-row-actions">
              <button type="button" tabIndex={-1} className="hud-entity-nav-btn" aria-label={`Teleport to ${entity.name}`} title="Teleport to entity"
                disabled={busy} onClick={() => void spaceUiStore.teleportToHostedEntity(entity.entity_id)}><LiaMapMarkerSolid size={12} aria-hidden="true" /> Teleport</button>
              <button type="button" tabIndex={-1} className="hud-entity-nav-btn hud-hosting-stop" aria-label={`Stop hosting ${entity.name}`}
                title="Stop hosting early · preserve unused prepaid time" disabled={busy || !entity.can_manage}
                onClick={() => void spaceUiStore.stopHostedEntity(entity.entity_id)}><FaStop size={10} aria-hidden="true" /> Stop</button>
            </div>
          </div>;
        })}
      </div>
    </div>}
  </section>;
}
