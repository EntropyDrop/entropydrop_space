import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IconType } from 'react-icons';
import { FaPlay, FaStop } from 'react-icons/fa';
import {
  LiaCheckSolid, LiaCodeSolid, LiaCopySolid, LiaEllipsisHSolid,
  LiaHourglassHalfSolid, LiaIdCardSolid, LiaPauseSolid,
  LiaServerSolid, LiaTimesSolid, LiaTrashAltSolid, LiaVectorSquareSolid
} from 'react-icons/lia';
import { SPACE_HOSTING_UI_ENABLED } from '../../../bootstrap/SpaceFeatures.ts';
import { spaceUiStore, hostingAvailabilityMessage } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';
import { entityDisplayName, entityRunStatus, EntityNameplateProjector, EntityNameplateAimHighlighter } from '../utils/entityNameplate.ts';
import { selectorMenuPosition } from '../utils/selectorMenuPosition.ts';

const statusIcons = { play: FaPlay, stop: FaStop, pause: LiaPauseSolid, waiting: LiaHourglassHalfSolid };

function EntityStatusBadge({ status, compact = true, showCaption = true, nameplate = false, canControl = true, onToggle, entityId }:
  { status: ReturnType<typeof entityRunStatus>; compact?: boolean; showCaption?: boolean; nameplate?: boolean; canControl?: boolean; onToggle?: () => void; entityId?: string }) {
  const caption = compact ? status.caption : status.text;
  const isRunning = status.running;
  const isInteractive = canControl && !!onToggle;
  const actionTitle = isInteractive
    ? (isRunning ? 'Running · Click to stop' : 'Stopped · Click to start')
    : (!canControl ? `${status.text} · read only` : status.text);
  return <span className={['entity-run-status', status.tone, isInteractive && 'is-clickable'].filter(Boolean).join(' ')} role="img" aria-label={status.text} title={actionTitle}
    onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
    onMouseUp={event => event.stopPropagation()}
    onClick={event => {
      event.stopPropagation();
      if (isInteractive) {
        event.preventDefault();
        onToggle();
      }
    }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    {status.tone === 'hosted' && <LiaServerSolid size={16} aria-hidden="true" />}
    <button
      type="button"
      tabIndex={-1}
      className={`entity-playback-icon ${status.icon} ${isRunning ? 'running' : 'stopped'}`}
      data-entity-nameplate-control={nameplate ? 'playback' : undefined}
      data-entity-playback-id={nameplate && entityId ? entityId : undefined}
      disabled={!canControl}
      aria-label={actionTitle}
      title={actionTitle}
      onClick={event => {
        event.stopPropagation();
        if (isInteractive) {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <span className={`entity-status-dot ${isRunning ? 'running' : 'stopped'}`} aria-hidden="true" />
    </button>
    {showCaption && caption && <span className="entity-run-caption">{caption}</span>}
  </span>;
}

function EntityActionButton({ label, caption = label, icon: Icon, title = label, ...props }:
  { label: string; caption?: string; icon: IconType } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type="button" role="menuitem" aria-label={label} title={title}>
    <Icon size={18} aria-hidden="true" />
    <span>{caption}</span>
  </button>;
}

export function EntityNameplates() {
  const { contraptions, sceneRenderer, hasStarted, activeModal, apiDocsOpen, currentUserName, controller } = useSpaceUi(state => state);
  const rootRef = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<any, HTMLDivElement>());
  const hidden = !hasStarted || !!activeModal || apiDocsOpen;
  useEffect(() => {
    if (!sceneRenderer?.subscribeWorldOverlay || hidden) return;
    const projector = new EntityNameplateProjector();
    const highlighter = new EntityNameplateAimHighlighter();
    const unsubscribe = sceneRenderer.subscribeWorldOverlay((camera: any) => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const active = new Set(contraptions?.contraptions || []);
      for (const [entity, element] of elements.current) {
        const position = active.has(entity) ? projector.project(entity, camera, viewport) : null;
        element.style.display = position ? '' : 'none';
        if (!position) continue;
        element.style.left = `${position.x}px`;
        element.style.top = `${position.y}px`;
        element.style.zIndex = String(Math.round((1 - position.depth) * 1000));
      }
      // Pointer lock hides the OS cursor; CSS :hover alone cannot track aim.
      // Hit-test once, after all projected labels have moved for this frame.
      const root = rootRef.current;
      if (root) {
        const state = spaceUiStore.getSnapshot();
        highlighter.update(root, !!(controller?.isLocked || state.pointerLocked || document.pointerLockElement), viewport,
          !!(state.activeModal || state.apiDocsOpen || state.entityContextMenu || state.selectorContextMenu));
      }
    });
    return () => { unsubscribe(); highlighter.clear(rootRef.current); };
  }, [sceneRenderer, contraptions, hidden, controller]);
  if (hidden) return null;
  return <div id="entity-nameplates" className="entity-nameplates" ref={rootRef}>
    {(contraptions?.contraptions || []).map((entity: any) => {
      const status = entityRunStatus(entity, currentUserName);
      const name = entityDisplayName(entity);
      const canControl = !entity.serverManaged || entity.serverCanControl === true;
      const open = (event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        spaceUiStore.showEntityContextMenu(entity, { x: rect.left + rect.width / 2, y: rect.bottom + 8 });
      };
      return <div key={entity.publicId || entity.id} className="entity-nameplate" style={{ display: 'none' }}
        ref={element => { if (element) elements.current.set(entity, element); else elements.current.delete(entity); }}>
        <EntityStatusBadge
          status={status}
          showCaption={status.tone !== 'running'}
          nameplate
          canControl={canControl}
          entityId={String(entity.publicId || entity.id)}
          onToggle={() => void spaceUiStore.toggleEntityRun(entity)}
        />
        <div className="entity-nameplate-labels">
          <span className="entity-nameplate-name" title={name}>{name}</span>
          {status.tone === 'running' && <span className="entity-nameplate-executor" title={`Executor: ${status.caption}`}>{status.caption}</span>}
        </div>
        <button type="button" tabIndex={-1} className="entity-menu-trigger" data-entity-menu-id={String(entity.publicId || entity.id)} data-entity-nameplate-control="menu"
          aria-label={`Entity actions: ${name}`} title="Entity actions · works with any tool"
          onMouseDown={event => { event.stopPropagation(); event.preventDefault(); }}
          onMouseUp={event => event.stopPropagation()} onClick={open} onContextMenu={open}><LiaEllipsisHSolid size={22} aria-hidden="true" /></button>
      </div>;
    })}
  </div>;
}

export function EntityContextMenu() {
  const { entityContextMenu, controller, currentUserName, hostingBusyIds, hosting } = useSpaceUi(state => state);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmHosting, setConfirmHosting] = useState(false);
  const [hostingBudget, setHostingBudget] = useState('1');
  useEffect(() => { setConfirmDelete(false); setConfirmHosting(false); setHostingBudget('1'); }, [entityContextMenu?.contraption]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !entityContextMenu) return;
    const update = () => setPosition(selectorMenuPosition(entityContextMenu,
      { width: menu.offsetWidth, height: menu.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(menu);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [entityContextMenu]);
  if (!entityContextMenu) return null;
  const entity = entityContextMenu.contraption;
  const status = entityRunStatus(entity, currentUserName);
  const canControl = !entity.serverManaged || entity.serverCanControl === true;
  const canEdit = !entity.serverManaged || entity.serverCanEdit === true;
  const hostingBusy = busy || hostingBusyIds.includes(String(entity.publicId));
  const isHosted = entity.serverExecutionMode === 'hosted';
  const hostingAction = async (enabled: boolean) => {
    if (hostingBusy) return;
    setBusy(true);
    try {
      const ok = enabled ? await spaceUiStore.hostEntity(entity, Number(hostingBudget))
        : await spaceUiStore.stopHostedEntity(String(entity.publicId));
      if (ok) setConfirmHosting(false);
      spaceUiStore.refresh();
    } finally { setBusy(false); }
  };
  const close = () => { if (!busy) spaceUiStore.closeEntityContextMenu(true); };
  const run = async (action: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const success = await controller?.performEntityMenuAction?.(entity, action);
      spaceUiStore.refresh();
      if (success && !['start', 'stop'].includes(action)) {
        spaceUiStore.closeEntityContextMenu(action !== 'program');
      }
    } finally { setBusy(false); }
  };
  return <div id="entity-context-menu-layer" className="selector-context-menu-layer"
    onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) close(); }}
    onMouseUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div id="entity-context-menu" ref={menuRef} role="menu" aria-label="Entity actions"
      className="selector-context-menu entity-context-menu" style={position}>
      <div className="selector-context-header">
        <div><div className="selector-context-kicker">ENTITY MENU</div><div className="selector-context-title">{entityDisplayName(entity)}</div></div>
        <button type="button" className="selector-context-close" aria-label="Close entity menu" title="Close entity menu" disabled={busy} onClick={close}><LiaTimesSolid size={18} aria-hidden="true" /></button>
      </div>
      <EntityStatusBadge status={status} compact={false} />
      <div className="selector-context-details">ID: {entity.publicId || entity.id}{!canControl ? ' · read only' : ''}</div>
      {entity.serverHostingCoreId != null && <div className="selector-context-details">Dedicated core {entity.serverHostingCoreId + 1}</div>}
      <div className="entity-context-actions">
        <EntityActionButton label="Start entity" caption="Start" icon={FaPlay} className="entity-action-start" disabled={busy || !canControl || status.running
          || (entity.serverExecutionMode === 'hosted' && !SPACE_HOSTING_UI_ENABLED)}
          title={entity.serverExecutionMode === 'hosted' && !SPACE_HOSTING_UI_ENABLED
            ? 'Server hosting is currently unavailable' : 'Start entity · physics and scripts'}
          onClick={() => void run('start')} />
        <EntityActionButton label="Stop entity" caption="Stop" icon={FaStop} className="entity-action-stop"
          disabled={busy || !canControl || !status.running} onClick={() => void run('stop')} />
        {isHosted && entity.serverHostingEnabled ?
          <EntityActionButton label="Stop hosting" icon={FaStop} className="entity-action-stop" disabled={hostingBusy || entity.serverCanManageHosting !== true}
            title="Stop server execution early · preserve unused prepaid time" onClick={() => void hostingAction(false)} />
          : <EntityActionButton label="Host on server" caption="Host…" icon={LiaServerSolid} disabled={hostingBusy}
            title="One dedicated core · 1 credit/hour" onClick={() => { setConfirmHosting(value => !value); void spaceUiStore.refreshHosting(); }} />}
        {confirmHosting && <div className="entity-hosting-confirm">
          <div>Server hosting · 1 dedicated core · 1 credit/hour</div>
          <div className="selector-context-details">{hostingAvailabilityMessage(hosting)}. Unused prepaid time is preserved.</div>
          {status.running && !isHosted && <div className="selector-context-details">Execution in this browser will stop before hosting starts.</div>}
          <label>Maximum credit budget <input type="number" min="1" max="168" step="1" value={hostingBudget}
            aria-label="Hosting credit budget" disabled={hostingBusy} onChange={event => setHostingBudget(event.target.value)} /></label>
          <EntityActionButton label="Confirm hosting" caption={hostingBusy ? 'Starting…' : 'Start hosting'} icon={LiaServerSolid}
            disabled={hostingBusy} onClick={() => void hostingAction(true)} />
          <EntityActionButton label="Cancel hosting" caption="Cancel" icon={LiaTimesSolid} disabled={hostingBusy} onClick={() => setConfirmHosting(false)} />
        </div>}
        <EntityActionButton label="Copy entity to backpack" caption="Copy to backpack" icon={LiaCopySolid} disabled={busy || (!canControl && status.running)} onClick={() => void run('copy')} />
        <EntityActionButton label="Open programming interface" caption="Program" icon={LiaCodeSolid} disabled={busy || !canEdit} onClick={() => void run('program')} />
        <EntityActionButton label="Select all root blocks" caption="Select all" icon={LiaVectorSquareSolid} disabled={busy || !canEdit} onClick={() => void run('select-all')} />
        <EntityActionButton label="Copy entity ID" caption="Copy ID" icon={LiaIdCardSolid} disabled={busy} onClick={async () => {
          try { await navigator.clipboard.writeText(String(entity.publicId || entity.id)); spaceUiStore.showToast('Entity ID copied'); }
          catch { spaceUiStore.showToast('Unable to copy entity ID', { tone: 'warning' }); }
        }} />
        {confirmDelete ? <div className="entity-delete-confirm" role="alert">
          <span>Delete this entire entity? This cannot be undone.</span>
          <EntityActionButton label={busy ? 'Deleting…' : 'Confirm delete'} icon={LiaCheckSolid} className="danger" disabled={busy} onClick={() => void run('delete')} />
          <EntityActionButton label="Cancel deletion" caption="Cancel" icon={LiaTimesSolid} disabled={busy} onClick={() => setConfirmDelete(false)} />
        </div> : <EntityActionButton label="Delete entity…" caption="Delete…" icon={LiaTrashAltSolid} className="danger" disabled={busy || !canControl} onClick={() => setConfirmDelete(true)} />}
      </div>
    </div>
  </div>;
}
