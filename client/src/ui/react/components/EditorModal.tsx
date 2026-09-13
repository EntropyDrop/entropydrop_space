import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SPACE_HOSTING_UI_ENABLED } from '../../../bootstrap/SpaceFeatures.ts';
import { apiDocsBodyMarkup } from '../apiDocsMarkup.ts';
import { resolveApiOrigin } from '../../../bootstrap/SpaceBootstrap.ts';
import {
  DEFAULT_AGENT_CONTEXT_K_TOKENS,
  DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS
} from '../../../engine/contraption/AgentConfig.ts';
import { compareComponentIds } from '@entropydrop/space-engine/contraption/Contraption.ts';
import { spaceUiStore, type AgentMessage } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';
import { AgentApiKeySecurityNotice } from './AgentApiKeySecurityNotice.tsx';
import { AgentModelField } from './AgentModelField.tsx';
import { ThoughtBox } from './ThoughtBox.tsx';

function nodeIcon(node: any): string {
  if (node?.parentId === null) return '★';
  return '•';
}

function HierarchyNode({ node, depth, selected }: { node: any; depth: number; selected: string }) {
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        className={`component-tree-node ${selected === node.id ? 'selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => spaceUiStore.selectComponentTreeNode(node.id)}
      >
        <span className="node-left">
          <span className="node-indent">{depth > 0 ? '└ ' : ''}</span>
          <span className="node-icon">{nodeIcon(node)}</span>
          <span className="node-name" title={node.id}>{node.name || node.id}{node.parentId === null ? ' (body)' : ''}</span>
        </span>
        <span className="node-right"><span className="node-kind-tag">{node.bodyType}</span><span className="node-count-badge">{node.blockCount} blk</span></span>
      </button>
      {(node.children || []).map((child: any) => <HierarchyNode key={child.id} node={child} depth={depth + 1} selected={selected} />)}
    </>
  );
}

type InspectorTab = 'defaults' | 'runtime';

/** True when the live BodyConfig values deviate from the persisted defaults. */
function bodyConfigDiffers(defaults: any, runtime: any): boolean {
  if (!runtime) return false;
  return runtime.bodyType !== defaults.bodyType
    || Math.abs(runtime.mass - defaults.mass) > 1e-9
    || Math.abs(runtime.restitution - defaults.restitution) > 1e-9
    || Math.abs(runtime.friction - defaults.friction) > 1e-9
    || runtime.useGravity !== defaults.useGravity
    || runtime.collisionEnabled !== defaults.collisionEnabled;
}

function formatTuple(value: unknown, suffix = ''): string {
  const parts = Array.isArray(value) ? value : [];
  return `[${parts.join(', ')}]${suffix}`;
}

function ComponentInspector() {
  const { editingContraption, selectedComponentNodeId } = useSpaceUi(state => state);
  const properties = editingContraption?.getNodeProperties?.(selectedComponentNodeId);
  const [name, setName] = useState(selectedComponentNodeId);
  const [displayName, setDisplayName] = useState(properties?.name || '');
  const [tab, setTab] = useState<InspectorTab>('defaults');
  useEffect(() => setName(properties?.id || selectedComponentNodeId), [properties?.id, selectedComponentNodeId]);
  useEffect(() => setDisplayName(properties?.name || ''), [properties?.name, selectedComponentNodeId]);
  if (!properties) return <div id="component-inspector-panel" className="component-inspector-panel"><div className="text-muted">No component selected</div></div>;
  const runtime = properties.runtimeBody;
  const runtimeDiffers = bodyConfigDiffers(properties, runtime);
  const runtimeNumber = (value: any, digits = 2) => Number(value ?? 0).toFixed(digits);
  const scriptState = properties.scriptError
    ? 'error'
    : !properties.hasScript
      ? 'empty'
      : properties.isScriptEnabled
        ? 'enabled'
        : 'disabled';
  return (
    <div id="component-inspector-panel" className="component-inspector-panel">
      <div className="inspector-field"><label className="inspector-label" htmlFor="prop-component-name">Name</label><div className="inspector-input-row"><input id="prop-component-name" className="inspector-input" placeholder={properties.id} value={displayName} onChange={event => setDisplayName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') spaceUiStore.setSelectedComponentName(displayName); }} /><button tabIndex={-1} className="small-action-btn" title="Set display name; duplicate and empty names are allowed" onClick={() => spaceUiStore.setSelectedComponentName(displayName)}>Save</button></div></div>
      <div className="inspector-field"><label className="inspector-label">ID</label><div className="inspector-input-row"><input id="prop-node-name" className="inspector-input" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') spaceUiStore.renameSelectedComponent(name); }} /><button id="prop-rename-btn" tabIndex={-1} className="small-action-btn" title="Rename component id (unique across the whole entity)" onClick={() => spaceUiStore.renameSelectedComponent(name)}>Rename</button></div></div>
      <div className="inspector-grid">
        <div className="inspector-field has-tooltip"><label className="inspector-sublabel" title="Derived hierarchy role: root body is the main rigid body, child is an attached sub-assembly">Role ⓘ</label><span id="prop-node-kind" className="inspector-val">{properties.kind === 'root' ? 'root body' : properties.kind}</span><div className="tooltip-text">Derived from the tree:<br /><b>root body</b> is the entity&apos;s main rigid body;<br /><b>child</b> is an attached sub-assembly.</div></div>
        <div className="inspector-field"><label className="inspector-sublabel">Parent</label><span id="prop-node-parent" className="inspector-val">{properties.parentId || 'None'}</span></div>
      </div>
      <div className="inspector-grid inspector-grid-three">
        <div className="inspector-field"><label className="inspector-sublabel">Script</label><span id="prop-node-script-state" className={`inspector-val inspector-state-${scriptState}`}>{scriptState}</span></div>
        <div className="inspector-field"><label className="inspector-sublabel">State Keys</label><span id="prop-node-state-keys" className="inspector-val mono">{properties.stateKeyCount}</span></div>
        <div className="inspector-field"><label className="inspector-sublabel">Constraints</label><span id="prop-node-constraints" className="inspector-val mono">{properties.constraintCount}</span></div>
      </div>
      {properties.scriptError ? <div id="prop-node-script-error" className="inspector-error">{properties.scriptError}</div> : null}
      <div className="inspector-tabbar">
        <button type="button" tabIndex={-1} id="inspector-tab-defaults" className={`inspector-tab ${tab === 'defaults' ? 'active' : ''}`} title="Persisted defaults — editable here; global Stop restores these values" onClick={() => setTab('defaults')}>Defaults</button>
        <button type="button" tabIndex={-1} id="inspector-tab-runtime" className={`inspector-tab ${tab === 'runtime' ? 'active' : ''}`} title="Live values — read-only; changed by component scripts" onClick={() => setTab('runtime')}>Runtime{runtimeDiffers ? <span className="inspector-tab-badge" title="Runtime values deviate from the defaults">Δ</span> : null}</button>
      </div>
      {tab === 'defaults' ? (
        <div className="inspector-tab-panel">
          <div className="inspector-grid inspector-grid-three">
            <div className="inspector-field has-tooltip"><label className="inspector-sublabel" htmlFor="prop-body-type" title="Rigid body mode">Rigid Body ⓘ</label><select id="prop-body-type" className="inspector-input" value={properties.bodyType} onChange={event => spaceUiStore.setSelectedBodyType(event.target.value)}><option value="kinematic">kinematic</option><option value="dynamic">dynamic</option></select><div className="tooltip-text"><b>kinematic</b>: Script-driven and immune to gravity/forces; collision-enabled poses are clipped against other entities.<br /><b>dynamic</b>: Full physics simulation.</div></div>
            <div className="inspector-field has-tooltip"><label className="inspector-sublabel" htmlFor="prop-restitution">Restitution ⓘ</label><input id="prop-restitution" className="inspector-input" type="number" min="0" max="1" step="0.01" value={Number(properties.restitution).toFixed(2)} onChange={event => spaceUiStore.setSelectedRestitution(Number(event.target.value))} /><div className="tooltip-text">Collision bounciness (0.0 to 1.0).</div></div>
            <div className="inspector-field has-tooltip"><label className="inspector-sublabel" htmlFor="prop-mass">Mass (kg) ⓘ</label><input id="prop-mass" className="inspector-input" type="number" min="0.1" step="1" value={Number(properties.mass).toFixed(1)} onChange={event => spaceUiStore.setSelectedMass(Number(event.target.value))} /><div className="tooltip-text">Mass in kg, determining inertia and acceleration.</div></div>
          </div>
          <div className="inspector-grid inspector-grid-three">
            <div className="inspector-field has-tooltip"><label className="inspector-sublabel" htmlFor="prop-friction">Friction ⓘ</label><input id="prop-friction" className="inspector-input" type="number" min="0" max="1" step="0.01" value={Number(properties.friction).toFixed(2)} onChange={event => spaceUiStore.setSelectedFriction(Number(event.target.value))} /><div className="tooltip-text">Surface friction (0.0 to 1.0).</div></div>
            <label className="inspector-field"><span className="inspector-sublabel">Use Gravity</span><input id="prop-use-gravity" type="checkbox" checked={properties.useGravity} onChange={event => spaceUiStore.setSelectedGravityEnabled(event.target.checked)} /></label>
            <label className="inspector-field"><span className="inspector-sublabel">Collision</span><input id="prop-collision-enabled" type="checkbox" checked={properties.collisionEnabled} onChange={event => spaceUiStore.setSelectedCollisionEnabled(event.target.checked)} /></label>
          </div>
          <div className="inspector-group-title">AUTHORED FRAME · XYZ / XYZW</div>
          <div className="inspector-transform-list">
            <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">Pivot XYZ ⓘ</span><span id="prop-node-pivot" className="inspector-val mono">{formatTuple(properties.pivot)}</span><div className="tooltip-text">The component-local point about which it rotates and where local force/torque coordinates are anchored. A quaternion describes orientation; it does not contain this pivot.</div></div>
            <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">Mount Q (xyzw) ⓘ</span><span id="prop-node-anchor-quaternion" className="inspector-val mono">{formatTuple(properties.anchorQuaternion)}</span><div className="tooltip-text">Axis-aligned mounting frame saved with the module. Hammer right-click changes this frame in 90° steps. It is separate from the component&apos;s current runtime rotation.</div></div>
            {properties.restLocalPosition ? <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">Stop Pos XYZ ⓘ</span><span id="prop-node-rest-pos" className="inspector-val mono">{formatTuple(properties.restLocalPosition)}</span><div className="tooltip-text">Authored child position relative to its parent. Global Stop restores this value.</div></div> : null}
            {properties.restLocalQuaternion ? <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">Stop Local Q ⓘ</span><span id="prop-node-rest-quaternion" className="inspector-val mono">{formatTuple(properties.restLocalQuaternion)}</span><div className="tooltip-text">Authored child quaternion relative to its parent, restricted to 90° grid rotations. Global Stop restores it so stopped component voxels return to their non-overlapping construction pose.</div></div> : null}
          </div>
          <div className="inspector-note">Persisted defaults — edits apply immediately and are written into inventory copies. Script <code>self.body.*</code> overrides are runtime-only; <b>Stop</b> restores these values.</div>
        </div>
      ) : (
        <div className="inspector-tab-panel">
          {runtime ? (
            <>
              <div className="inspector-grid inspector-grid-three">
                <div className="inspector-field"><label className="inspector-sublabel">Rigid Body</label><span id="runtime-body-type" className="inspector-val mono">{runtime.bodyType}</span></div>
                <div className="inspector-field"><label className="inspector-sublabel">Mass (kg)</label><span id="runtime-mass" className="inspector-val mono">{runtimeNumber(runtime.mass, 1)}</span></div>
                <div className="inspector-field"><label className="inspector-sublabel">Restitution</label><span id="runtime-restitution" className="inspector-val mono">{runtimeNumber(runtime.restitution)}</span></div>
              </div>
              <div className="inspector-grid inspector-grid-three">
                <div className="inspector-field"><label className="inspector-sublabel">Friction</label><span id="runtime-friction" className="inspector-val mono">{runtimeNumber(runtime.friction)}</span></div>
                <div className="inspector-field"><label className="inspector-sublabel">Use Gravity</label><span id="runtime-use-gravity" className="inspector-val mono">{runtime.useGravity ? 'on' : 'off'}</span></div>
                <div className="inspector-field"><label className="inspector-sublabel">Collision</label><span id="runtime-collision-enabled" className="inspector-val mono">{runtime.collisionEnabled ? 'on' : 'off'}</span></div>
              </div>
              <div className="inspector-grid inspector-grid-three">
                <div className="inspector-field"><label className="inspector-sublabel">Simulation</label><span id="runtime-simulation-enabled" className="inspector-val mono">{runtime.simulationEnabled ? 'active' : 'stopped'}</span></div>
                <div className="inspector-field"><label className="inspector-sublabel">Grounded</label><span id="runtime-grounded" className="inspector-val mono">{runtime.isOnGround ? 'yes' : 'no'}</span></div>
                <div className="inspector-field"><label className="inspector-sublabel">Speed</label><span id="runtime-speed" className="inspector-val mono">{runtimeNumber(runtime.speed)} m/s</span></div>
              </div>
              <div className="inspector-group-title">LIVE COMPONENT FRAME · XYZ / XYZW</div>
              <div className="inspector-transform-list">
                <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">{properties.parentId ? 'Local Pos XYZ' : 'Root Local Pos'} ⓘ</span><span id="prop-node-pos" className="inspector-val mono">{formatTuple(properties.localPosition)}</span><div className="tooltip-text">{properties.parentId ? 'Current pivot position relative to the parent component.' : 'The root has no parent, so its script-local position is [0, 0, 0]. Use World Pos for its actual location.'}</div></div>
                <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">Local Q (xyzw) ⓘ</span><span id="prop-node-local-quaternion" className="inspector-val mono">{formatTuple(properties.localQuaternion)}</span><div className="tooltip-text">Current quaternion relative to the parent. For root this is its world orientation. This is the value returned by <code>self.getLocalRotation()</code>.</div></div>
                <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">Local Euler YXZ ⓘ</span><span id="prop-node-rot" className="inspector-val mono">{formatTuple(properties.localEuler.map((value: number) => `${value}°`))}</span><div className="tooltip-text">The same local orientation converted to Euler angles for readability. Scripts and persistence use the quaternion.</div></div>
                <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">World Pos XYZ ⓘ</span><span id="prop-node-world-pos" className="inspector-val mono">{formatTuple(properties.worldPosition)}</span><div className="tooltip-text">Current component pivot in world coordinates.</div></div>
                <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">World Q (xyzw) ⓘ</span><span id="prop-node-world-quaternion" className="inspector-val mono">{formatTuple(properties.worldQuaternion)}</span><div className="tooltip-text">Current world quaternion after composing all ancestor rotations. This is returned by <code>self.getWorldRotation()</code>.</div></div>
              </div>
              <div className="inspector-group-title">LIVE RIGID BODY</div>
              <div className="inspector-transform-list">
                <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">COM World Pos ⓘ</span><span id="runtime-body-position" className="inspector-val mono">{formatTuple(runtime.position)}</span><div className="tooltip-text">World-space center of mass used by the physics solver; it can differ from the pivot.</div></div>
                <div className="inspector-transform-row has-tooltip"><span className="inspector-sublabel">Body World Q ⓘ</span><span id="runtime-body-quaternion" className="inspector-val mono">{formatTuple(runtime.quaternion)}</span><div className="tooltip-text">World orientation used by the rigid-body collision solver.</div></div>
                <div className="inspector-transform-row"><span className="inspector-sublabel">Velocity XYZ</span><span id="runtime-velocity" className="inspector-val mono">{formatTuple(runtime.velocity, ' m/s')}</span></div>
                <div className="inspector-transform-row"><span className="inspector-sublabel">Angular XYZ</span><span id="runtime-angular-velocity" className="inspector-val mono">{formatTuple(runtime.angularVelocity, ' rad/s')}</span></div>
                <div className="inspector-transform-row"><span className="inspector-sublabel">Spin</span><span id="runtime-spin" className="inspector-val mono">{runtimeNumber(runtime.rpm, 1)} rpm</span></div>
              </div>
              <div className="inspector-note">Live values — <b>read-only</b>. Change them from component code (<code>self.body.*</code> setters, kinematic pose commands). <b>Stop</b> resets child poses and restores the Defaults.</div>
            </>
          ) : <div className="text-muted">No live body data</div>}
        </div>
      )}
      <div className="inspector-grid"><div className="inspector-item"><span className="inspector-sublabel">Blocks</span><span id="prop-node-blocks" className="inspector-num">{properties.blockCount} blocks</span></div><div className="inspector-item"><span className="inspector-sublabel">Volume</span><span id="prop-node-volume" className="inspector-num">{properties.volume} m³</span></div></div>
    </div>
  );
}

function AgentChat() {
  const state = useSpaceUi(snapshot => snapshot);
  const [prompt, setPrompt] = useState('');
  const [config, setConfig] = useState(state.agentConfig || {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  useEffect(() => setConfig(state.agentConfig || {}), [state.agentConfig]);

  const handleChatScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledUpRef.current = !isAtBottom;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.agentMessages]);

  useEffect(() => {
    if (state.agentBusy) {
      userScrolledUpRef.current = false;
    }
  }, [state.agentBusy]);

  const send = async () => {
    const value = prompt.trim();
    if (!value) return;
    setPrompt('');
    await spaceUiStore.sendAgentMessage(value);
  };
  const renderMessage = (message: AgentMessage, index: number) => (
    <React.Fragment key={index}>
      <div className={`agent-chat-msg ${message.role === 'user' ? 'agent-msg-user' : 'agent-msg-assistant'}`}>
        <ThoughtBox reasoning={message.reasoning} isStreaming={message.isStreaming} title="Thought" />
        {message.content ? <div className="agent-msg-text">{message.content}</div> : message.isStreaming ? <div className="agent-msg-text text-muted">Generating... ▌</div> : null}
      </div>
      {message.role === 'assistant' && message.code && !message.isStreaming ? <button tabIndex={-1} className="agent-apply-btn" onClick={() => spaceUiStore.applyAgentCode(message.code!, message.targetId || state.editingContraption?.rootComponentId)}>Apply to {message.targetId || state.editingContraption?.rootComponentId} component</button> : null}
    </React.Fragment>
  );
  return (
    <div className="agent-column">
      <div className="telemetry-section-title agent-chat-title"><span>AI ASSISTANT</span><div className="agent-title-actions"><button id="agent-clear-btn" tabIndex={-1} className="mini-toggle-btn reset" title="Clear chat history" onClick={() => spaceUiStore.clearAgentChat()}>🗑 CLEAR</button><button id="agent-settings-btn" tabIndex={-1} className={`mini-toggle-btn reset ${state.agentSetupOpen ? 'active' : ''}`} title="Toggle model API settings" onClick={() => spaceUiStore.toggleAgentSetup()}>⚙ SETUP <span id="agent-setup-arrow" className="setup-arrow">{state.agentSetupOpen ? '▲' : '▼'}</span></button></div></div>
      <div id="agent-setup-accordion" className="agent-setup-accordion" style={{ display: state.agentSetupOpen ? 'flex' : 'none' }}>
        <div className="agent-config-field"><span className="config-label">API Base URL</span><input id="agent-api-base" className="config-input" value={config.baseUrl || ''} placeholder="https://api.openai.com/v1" onChange={event => setConfig({ ...config, baseUrl: event.target.value })} /></div>
        <div className="agent-config-field"><span className="config-label">API Key</span><input id="agent-api-key" className="config-input" type="password" autoComplete="off" value={config.apiKey || ''} placeholder="sk-... (this tab only by default)" onChange={event => setConfig({ ...config, apiKey: event.target.value })} /><label className="agent-key-persistence-option"><input type="checkbox" checked={config.rememberApiKey === true} aria-describedby="agent-api-key-security-notice" onChange={event => setConfig({ ...config, rememberApiKey: event.target.checked })} />Persist API key on this device (plaintext localStorage)</label></div>
        <AgentApiKeySecurityNotice id="agent-api-key-security-notice" rememberApiKey={config.rememberApiKey === true} />
        <AgentModelField
          inputId="agent-api-model"
          baseUrl={config.baseUrl || ''}
          apiKey={config.apiKey || ''}
          model={config.model || ''}
          onModelChange={model => setConfig((current: any) => ({ ...current, model }))}
        />
        <div className="agent-config-field"><span className="config-label">Context Window (K tokens)</span><input id="agent-context-length" className="config-input" type="number" min="1" max="2048" step="1" value={config.contextKTokens ?? DEFAULT_AGENT_CONTEXT_K_TOKENS} onChange={event => setConfig({ ...config, contextKTokens: event.target.value })} /></div>
        <div className="agent-config-field"><span className="config-label">Max Output (K tokens)</span><input id="agent-max-tokens" className="config-input" type="number" min="0.1" max="128" step="0.5" value={config.maxOutputKTokens ?? DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS} onChange={event => setConfig({ ...config, maxOutputKTokens: event.target.value })} /></div>
        <div className="agent-config-field"><span className="config-label">Timeout (Seconds)</span><input id="agent-timeout" className="config-input" type="number" min="5" max="600" step="5" value={config.timeoutSeconds ?? 60} onChange={event => setConfig({ ...config, timeoutSeconds: event.target.value })} /></div>
        <div className="agent-config-actions"><button id="agent-config-save-btn" tabIndex={-1} className="small-btn primary" onClick={() => spaceUiStore.saveAgentSettings(config)}>Save Config</button></div>
        <div className="config-hint">Model choices load from API Base URL + /models. Without a key, uses local compiler.</div>
      </div>
      <div id="agent-chat-box" className="agent-chat-box" ref={scrollRef} onScroll={handleChatScroll}>
        {state.agentMessages.length ? state.agentMessages.map(renderMessage) : <div className="agent-chat-msg agent-msg-system">Describe a behavior in plain language (e.g. &quot;hover 5m&quot;, &quot;follow me&quot;).<br />Generated code remains inert until you click Apply.<br />· {state.agentConfig?.apiKey ? `Model connected: ${state.agentConfig.model}` : 'Using built-in local compiler'}</div>}
      </div>
      <div className="agent-chat-input-row"><input id="agent-chat-input" className="agent-chat-input" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void send(); } }} placeholder="e.g. follow me 3m behind to the right..." /><button id="agent-chat-send-btn" tabIndex={-1} className="agent-send-btn" disabled={state.agentBusy} onClick={() => void send()}>{state.agentBusy ? '…' : 'Send'}</button></div>
    </div>
  );
}

export function CodeEditorModal() {
  const state = useSpaceUi(snapshot => snapshot);
  const attachPreviewCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    if (canvas) state.sceneRenderer?.setEntityPreviewCanvas?.(canvas);
  }, [state.sceneRenderer]);
  const open = state.activeModal === 'code' && !!state.editingContraption;
  const contraption = state.editingContraption;
  const tree = useMemo(() => contraption?.getHierarchyTree?.(), [contraption, state.revision]);
  const nodes = contraption
    ? [...(contraption.entityNodes?.values?.() || [])]
      .sort((left: any, right: any) => compareComponentIds(left.id, right.id))
    : [];
  const playback = spaceUiStore.getGlobalPlayback();
  if (!open) return null;
  const childIds = nodes
    .filter((node: any) => node.parentId !== null)
    .map((node: any) => node.id)
    .sort(compareComponentIds);
  const runtimeTitle = `Runtime: #${contraption.id} (${contraption.blocks.length} blocks) · ${String(contraption.bodyType).toUpperCase()}${childIds.length ? ` · children: ${childIds.join(', ')}` : ' · no children'}`;
  const status = playback === 'play' ? 'running' : 'stopped';
  const backendManaged = contraption.serverManaged === true;
  const persistenceLabel = backendManaged ? 'backend' : 'session';
  const sourceLabel = backendManaged ? 'world entity' : 'local';
  const accessLabel = backendManaged
    ? contraption.serverCanEdit === true
      ? contraption.serverCanControl === true ? 'edit + control' : 'edit only'
      : contraption.serverCanControl === true ? 'control only' : 'read only'
    : 'local owner';
  const executorLabel = !backendManaged
    ? 'this browser'
    : contraption.serverExecutionMode === 'hosted'
      ? SPACE_HOSTING_UI_ENABLED
        ? contraption.serverHostingEnabled ? 'server hosting · 1 credit/hour' : 'server hosting · disabled'
        : 'server managed'
    : contraption.serverDesiredRunState === 'stopped'
      ? 'stopped'
      : contraption.serverExecutesLocally === true
        ? 'this browser (lease)'
        : 'owner browser / waiting';
  return (
    <div id="code-editor-modal" className="custom-modal open" onMouseDown={event => { if (event.target === event.currentTarget) spaceUiStore.toggleCodeEditorModal(false); }}>
      <div className="modal-content code-editor-container">
        <div className="editor-header">
          <div className="editor-title-group"><div className="editor-title">Entity Editor</div><button id="editor-entity-id" tabIndex={-1} className="editor-tag" title={runtimeTitle} onClick={() => { void navigator.clipboard?.writeText?.(String(contraption.publicId)); spaceUiStore.showToast(`Entity ID copied: ${contraption.publicId}`); }}>ID: {contraption.publicId}</button><div id="editor-status-badge" title={`Component scripts: ${state.telemetry.status}`} className={`status-badge ${status}`}>{status.toUpperCase()}</div><div id="editor-exec-time" className="exec-time">{state.telemetry.executionTime}</div></div>
          <div className="editor-actions">
            <div className="pb-radio-group" id="global-playback-group" title="Entity physics and script control">
              {([['play', '▶', 'Start: enable entity physics and all component scripts'], ['stop', '⏹', 'Stop: disable entity physics and scripts, then restore PB BodyConfig defaults, state, clock, transforms, and forces']] as const).map(([value, label, title]) => <React.Fragment key={value}><input type="radio" id={`pb-global-${value}`} name="pb-global" value={value} checked={playback === value} onChange={() => { void spaceUiStore.setGlobalPlayback(value); }} /><label htmlFor={`pb-global-${value}`} className={`pb-option ${value}`} title={title}>{label}</label></React.Fragment>)}
            </div>
            <button id="run-script-btn" tabIndex={-1} className="editor-btn run-btn" onClick={() => spaceUiStore.applyAndRunScript()}>Apply Code</button>
            <button id="api-docs-btn" tabIndex={-1} className="editor-btn" title="Open entityAPI docs for entity code, with links to spaceAPI for Agent HTTP requests" onClick={() => spaceUiStore.toggleApiDocs(true)}>📖 entityAPI Docs</button>
            <button id="close-code-btn" tabIndex={-1} className="icon-btn" style={{ width: 28, height: 28, fontSize: 13 }} title="Close terminal (ESC)" onClick={() => spaceUiStore.toggleCodeEditorModal(false)}>✕</button>
          </div>
        </div>
        <div className="editor-body">
          <div className="hierarchy-sidebar">
            <div className="sidebar-section-title"><span>ENTITY COMPONENT TREE</span></div>
            <div id="component-tree-panel" className="component-tree-panel"><div id="component-tree-list" className="component-tree-list">{tree ? <HierarchyNode node={tree} depth={0} selected={state.selectedComponentNodeId} /> : <div className="text-muted">No component hierarchy</div>}</div></div>
            <div className="sidebar-section-title" style={{ marginTop: 8 }}><span>COMPONENT INSPECTOR</span><span id="component-inspector-id" className="component-inspector-badge">{state.selectedComponentNodeId}</span></div>
            <ComponentInspector />
          </div>
          <div className="code-area-wrapper">
            <div className="code-tab-bar" id="code-tab-bar">{nodes.map((node: any) => {
              const code = contraption.getNodeScript(node.id);
              const enabled = contraption.isNodeScriptEnabled(node.id);
              return <button type="button" tabIndex={-1} key={node.id} className={`code-tab ${state.selectedComponentNodeId === node.id ? 'active' : ''} ${code?.trim?.() ? 'has-script' : ''} ${enabled ? 'enabled' : 'disabled'}`} onClick={() => spaceUiStore.selectComponentTreeNode(node.id)}><span className={`code-tab-dot ${enabled ? 'on' : 'off'}`} /><span>{nodeIcon(node)} {node.id}.js</span></button>;
            })}</div>
            <div className="code-editor-main"><div className="code-gutter" id="code-gutter" /><textarea id="script-textarea" className="code-textarea" spellCheck={false} placeholder="// Write your controller code here..." value={state.scriptDraft} onChange={event => spaceUiStore.setScriptDraft(event.target.value)} /></div>
            <div className="code-footer-hint" id="code-footer-hint"><span id="code-target-hint">Editing: {nodeIcon(contraption.getEntityNode?.(state.selectedComponentNodeId))} {state.selectedComponentNodeId}{contraption.getEntityNode?.(state.selectedComponentNodeId)?.parentId === null ? ' (body)' : ''}</span><span id="code-api-hint" className="code-api-hint">entityAPI: self · ctx</span></div>
          </div>
          <div className="telemetry-panel">
            <div className="telemetry-section-title">3D VIEW</div><div className="entity-preview-frame"><canvas id="entity-preview-canvas" aria-label="Interactive preview of the entity in the current world" ref={attachPreviewCanvas} /></div>
            <div className="telemetry-section-title">ENTITY AUTHORITY</div>
            <div id="entity-authority-grid" className="telemetry-grid telemetry-grid-compact">
              <div className="telemetry-item"><span className="tele-label">Persistence</span><span id="tele-entity-persistence" className="tele-val">{persistenceLabel}</span></div>
              <div className="telemetry-item"><span className="tele-label">Source</span><span id="tele-entity-source" className="tele-val">{sourceLabel}</span></div>
              <div className="telemetry-item"><span className="tele-label">Access</span><span id="tele-entity-access" className="tele-val">{accessLabel}</span></div>
              <div className="telemetry-item"><span className="tele-label">Executor</span><span id="tele-entity-executor" className="tele-val">{executorLabel}</span></div>
              {backendManaged ? <div className="telemetry-item telemetry-item-wide"><span className="tele-label">Backend Revision</span><span id="tele-entity-revision" className="tele-val mono">definition {Number(contraption.serverRevision) || 0} · playback {Number(contraption.serverPlaybackRevision) || 0}</span></div> : null}
            </div>
            <div className="telemetry-section-title">entityAPI STATE</div>
            <div className="telemetry-grid">
              <div className="telemetry-item"><span className="tele-label">Ground Dist</span><span id="tele-ground-dist" className="tele-val highlight">{state.telemetry.groundDistance}</span></div>
              <div className="telemetry-item"><span className="tele-label">Altitude</span><span id="tele-altitude" className="tele-val">{state.telemetry.altitude}</span></div>
              <div className="telemetry-item"><span className="tele-label">Speed</span><span id="tele-speed" className="tele-val">{state.telemetry.speed}</span></div>
              <div className="telemetry-item"><span className="tele-label">Mass</span><span id="tele-mass" className="tele-val">{state.telemetry.mass}</span></div>
              <div className="telemetry-item power-item has-tooltip"><span className="tele-label">Root Power Budget ⓘ</span><span id="tele-power" className="tele-val highlight">{state.telemetry.powerPercent}%</span><span className="power-meter"><span id="tele-power-fill" style={{ width: `${state.telemetry.powerPercent}%` }} /></span><div className="tooltip-text">Legacy root-body force budget used by top-level force and torque calls.</div></div>
            </div>
            <div className="telemetry-section-title" style={{ marginTop: 8 }}>CONSOLE LOGS</div><div id="tele-console-logs" className="console-logs-box">{state.telemetry.logs.map((line, index) => <div key={index} className={`log-line ${state.telemetry.logs.length === 1 && line.startsWith('No ') ? 'text-muted' : ''}`}>{line}</div>)}</div>
          </div>
          <AgentChat />
        </div>
      </div>
    </div>
  );
}

export function ApiDocsModal() {
  const open = useSpaceUi(state => state.apiDocsOpen);
  if (!open) return null;
  const apiOrigin = spaceUiStore.getApiKeyClient()?.getAgentConnection().origin || resolveApiOrigin(
    import.meta.env.VITE_SPACE_API_BASE_URL || import.meta.env.VITE_API_BASE_URL, window.location.origin,
  );
  return (
    <div id="api-docs-modal" className="custom-modal open" onMouseDown={event => { if (event.target === event.currentTarget) spaceUiStore.toggleApiDocs(false); }}>
      <div className="modal-content api-docs-container">
        <div className="modal-header"><h2>📖 entityAPI V2 REFERENCE</h2><button id="close-api-docs-btn" tabIndex={-1} className="icon-btn" style={{ width: 28, height: 28, fontSize: 13 }} title="Close docs (ESC)" onClick={() => spaceUiStore.toggleApiDocs(false)}>✕</button></div>
        <div className="modal-sub">Entity code → entityAPI (self / ctx) · Agent HTTP requests → spaceAPI · one script per component</div>
        <div className="api-docs-body" id="api-docs-body" dangerouslySetInnerHTML={{ __html: apiDocsBodyMarkup(apiOrigin) }} />
      </div>
    </div>
  );
}
