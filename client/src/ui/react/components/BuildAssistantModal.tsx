import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_AGENT_CONTEXT_K_TOKENS,
  DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS
} from '../../../engine/contraption/AgentConfig.ts';
import {
  LiaRobotSolid,
  LiaUndoAltSolid,
  LiaTrashAltSolid,
  LiaSlidersHSolid,
  LiaCubeSolid,
  LiaCubesSolid,
  LiaBoxesSolid,
  LiaLayerGroupSolid,
  LiaDraftingCompassSolid,
  LiaVectorSquareSolid,
  LiaCheckSolid,
  LiaBanSolid,
  LiaExclamationTriangleSolid,
  LiaInfoCircleSolid,
  LiaKeySolid,
  LiaProjectDiagramSolid,
  LiaBoltSolid
} from 'react-icons/lia';
import { spaceUiStore, type BuildAgentMessage } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';
import { AgentModelField } from './AgentModelField.tsx';
import { AgentApiKeySecurityNotice } from './AgentApiKeySecurityNotice.tsx';
import { ThoughtBox } from './ThoughtBox.tsx';

const PROMPT_SUGGESTIONS = [
  {
    icon: '🏰',
    title: 'Stone Cottage',
    prompt: 'A 7x5 stone cottage with a wooden doorway and pitched blue roof'
  },
  {
    icon: '🚗',
    title: 'Rover Vehicle',
    prompt: 'A dynamic 4-wheel rover vehicle entity with steering joints and a driver seat'
  },
  {
    icon: '🗼',
    title: 'Radio Tower',
    prompt: 'A tall symmetrical radio transmission tower with an observation beacon'
  },
  {
    icon: '🛸',
    title: 'Hover Platform',
    prompt: 'A hovering sci-fi drone platform with corner thruster blocks and lights'
  }
];

function BuildMessage({ message }: { message: BuildAgentMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`build-agent-message ${message.role}`}>
      <div className="build-agent-message-header">
        <span className="build-agent-sender-badge">
          {isUser ? 'YOU' : 'AI BUILDER'}
        </span>
        {!isUser && message.isStreaming ? (
          <span className="build-agent-live-badge">GENERATING</span>
        ) : null}
      </div>
      <ThoughtBox reasoning={message.reasoning} isStreaming={message.isStreaming} />
      <div className="build-agent-message-body">
        {message.content || (message.isStreaming ? 'Generating validated blueprint…' : '')}
        {message.isStreaming ? <span className="streaming-cursor">▌</span> : null}
      </div>
    </div>
  );
}

function BuilderProgress() {
  const job = useSpaceUi(state => state.builderJob);
  if (!job) return null;
  const percent = job.total > 0 ? Math.min(100, Math.round(job.processed / job.total * 100)) : 100;
  const active = !['complete', 'failed', 'cancelled'].includes(job.phase);
  return (
    <div className={`build-agent-job phase-${job.phase}`}>
      <div className="build-agent-job-heading">
        <span className="build-job-label flex items-center gap-1">
          <LiaBoltSolid size={14} />
          {job.label}
        </span>
        <span className={`build-job-phase-badge ${job.phase}`}>
          {job.phase.replace('_', ' ').toUpperCase()}
        </span>
      </div>
      <div className="build-agent-progress-track">
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="build-agent-job-meta">
        <span>{job.processed.toLocaleString()} / {job.total.toLocaleString()} voxels ({percent}%)</span>
        <span>{job.changed.toLocaleString()} modified</span>
      </div>
      {job.detail ? <div className="build-agent-job-detail">{job.detail}</div> : null}
      {active ? (
        <button
          type="button"
          tabIndex={-1}
          className="small-btn danger build-job-cancel-btn"
          onClick={() => spaceUiStore.cancelBuilderJob()}
        >
          <LiaBanSolid size={13} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />
          Cancel &amp; Rollback
        </button>
      ) : null}
    </div>
  );
}

export function BuildAssistantModal() {
  const state = useSpaceUi(snapshot => snapshot);
  const [prompt, setPrompt] = useState('');
  const [config, setConfig] = useState(state.agentConfig || {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const open = state.activeModal === 'builder';

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
  }, [state.buildAgentMessages]);

  useEffect(() => {
    if (state.buildAgentBusy) {
      userScrolledUpRef.current = false;
    }
  }, [state.buildAgentBusy]);

  if (!open) return null;

  const send = async () => {
    const value = prompt.trim();
    if (!value || state.buildAgentBusy || !!activeJob) return;
    setPrompt('');
    await spaceUiStore.sendBuildAgentMessage(value);
  };

  const handleApplyPreset = (presetPrompt: string) => {
    setPrompt(presetPrompt);
    textareaRef.current?.focus();
  };

  const summary = state.buildValidation?.summary;
  const activeJob = state.builderJob
    && !['complete', 'failed', 'cancelled'].includes(state.builderJob.phase);
  const history = state.builder?.getHistory?.() || [];
  const modelName = config.model || (config.apiKey ? 'Default LLM' : 'Built-in Compiler');

  return (
    <div
      id="build-assistant-modal"
      className="custom-modal open"
      onMouseDown={event => {
        if (event.target === event.currentTarget) spaceUiStore.toggleBuildAssistant(false);
      }}
    >
      <div className="modal-content build-assistant-container">
        {/* Header */}
        <div className="modal-header build-assistant-header">
          <div className="build-assistant-title-group">
            <div className="build-assistant-title-row">
              <span className="build-assistant-icon-badge">
                <LiaRobotSolid size={18} />
              </span>
              <h2>AI BUILDER</h2>
              <span className="build-assistant-status-pill">
                <span className="build-assistant-status-dot" />
                {modelName}
              </span>
            </div>
            <div className="build-assistant-flow-steps">
              <span className="flow-step active">1. Describe Structure</span>
              <span className="flow-sep">→</span>
              <span className="flow-step">2. Hologram Preview</span>
              <span className="flow-sep">→</span>
              <span className="flow-step">3. Confirm Build</span>
            </div>
          </div>

          <div className="build-assistant-header-actions">
            <button
              type="button"
              tabIndex={-1}
              className="small-btn build-header-btn"
              disabled={!history.length || !!activeJob}
              title="Undo last construction"
              onClick={() => spaceUiStore.undoLastBuild()}
            >
              <LiaUndoAltSolid size={13} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 3 }} />
              Undo Last
            </button>
            <button
              type="button"
              tabIndex={-1}
              className="small-btn build-header-btn"
              title="Clear chat history"
              onClick={() => spaceUiStore.clearBuildAgent()}
            >
              <LiaTrashAltSolid size={13} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 3 }} />
              Clear
            </button>
            <button
              type="button"
              tabIndex={-1}
              className={`small-btn build-header-btn ${state.buildAgentSetupOpen ? 'active' : ''}`}
              title="Toggle model and API settings"
              onClick={() => spaceUiStore.toggleBuildAgentSetup()}
            >
              <LiaSlidersHSolid size={13} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 3 }} />
              Setup
            </button>
            <button
              type="button"
              tabIndex={-1}
              className="icon-btn close-modal-btn"
              title="Close builder (ESC)"
              onClick={() => spaceUiStore.toggleBuildAssistant(false)}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Setup Accordion */}
        {state.buildAgentSetupOpen ? (
          <div className="build-agent-setup">
            <div className="build-agent-setup-header">
              <div className="build-setup-title-group">
                <span className="build-setup-title flex items-center gap-1.5">
                  <LiaKeySolid size={14} /> LLM API &amp; MODEL CONFIGURATION
                </span>
                <span className="build-setup-subtitle">
                  Configure OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, OpenAI, etc.)
                </span>
              </div>
            </div>

            <div className="build-setup-form">
              {/* Row 1: API Base URL & API Key */}
              <div className="build-setup-row-endpoints">
                <div className="build-setup-field">
                  <div className="build-field-label">
                    <span>API Base URL</span>
                    <span className="build-field-tag">e.g. http://localhost:11434/v1</span>
                  </div>
                  <input
                    className="config-input"
                    placeholder="http://localhost:11434/v1 or https://api.openai.com/v1"
                    value={config.baseUrl || ''}
                    onChange={event => setConfig({ ...config, baseUrl: event.target.value })}
                  />
                </div>
                <div className="build-setup-field">
                  <div className="build-field-label">
                    <span>API Key</span>
                    <span className="build-field-tag">Optional for local Ollama / LM Studio</span>
                  </div>
                  <input
                    className="config-input"
                    type="password"
                    autoComplete="off"
                    placeholder="sk-... (kept for this tab by default)"
                    value={config.apiKey || ''}
                    onChange={event => setConfig({ ...config, apiKey: event.target.value })}
                  />
                  <label className="agent-key-persistence-option">
                    <input
                      type="checkbox"
                      checked={config.rememberApiKey === true}
                      aria-describedby="build-agent-api-key-security-notice"
                      onChange={event => setConfig({ ...config, rememberApiKey: event.target.checked })}
                    />
                    Persist API key on this device (plaintext localStorage)
                  </label>
                </div>
              </div>
              <AgentApiKeySecurityNotice id="build-agent-api-key-security-notice" rememberApiKey={config.rememberApiKey === true} />

              {/* Row 2: Model & Token Lengths */}
              <div className="build-setup-row-model">
                <div className="build-setup-field model-col">
                  <AgentModelField
                    className="build-agent-model-field"
                    inputId="build-agent-api-model"
                    label={
                      <div className="build-field-label">
                        <span>Model Name</span>
                        <span className="build-field-tag">e.g. qwen2.5-coder:7b</span>
                      </div>
                    }
                    baseUrl={config.baseUrl || ''}
                    apiKey={config.apiKey || ''}
                    model={config.model || ''}
                    onModelChange={model => setConfig((current: any) => ({ ...current, model }))}
                  />
                </div>
                <div className="build-setup-field token-col">
                  <div className="build-field-label">
                    <span>Context (K)</span>
                  </div>
                  <input
                    className="config-input"
                    type="number"
                    min="1"
                    max="2048"
                    value={config.contextKTokens ?? DEFAULT_AGENT_CONTEXT_K_TOKENS}
                    onChange={event => setConfig({ ...config, contextKTokens: event.target.value })}
                  />
                </div>
                <div className="build-setup-field token-col">
                  <div className="build-field-label">
                    <span>Output (K)</span>
                  </div>
                  <input
                    className="config-input"
                    type="number"
                    min="0.1"
                    max="128"
                    step="0.5"
                    value={config.maxOutputKTokens ?? DEFAULT_AGENT_MAX_OUTPUT_K_TOKENS}
                    onChange={event => setConfig({ ...config, maxOutputKTokens: event.target.value })}
                  />
                </div>
                <div className="build-setup-field token-col">
                  <div className="build-field-label">
                    <span>Timeout (s)</span>
                  </div>
                  <input
                    className="config-input"
                    type="number"
                    min="5"
                    max="600"
                    step="5"
                    value={config.timeoutSeconds ?? 60}
                    onChange={event => setConfig({ ...config, timeoutSeconds: event.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="build-agent-setup-footer">
              <button
                type="button"
                tabIndex={-1}
                className="small-btn primary save-config-btn"
                onClick={() => spaceUiStore.saveAgentSettings(config)}
              >
                <LiaCheckSolid size={14} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />
                Save Model Configuration
              </button>
              <div className="config-hint flex items-center gap-1.5">
                <LiaInfoCircleSolid size={14} />
                <span>Blueprints never execute until you confirm.</span>
              </div>
            </div>
          </div>
        ) : null}

        {/* Main Body */}
        <div className="build-assistant-body">
          {/* Left Column: Chat & Prompt */}
          <div className="build-agent-chat-column">
            <div className="build-column-header">
              <span className="build-column-title">PROMPT TERMINAL</span>
              <span className="build-column-meta">
                {state.buildAgentMessages.length > 0
                  ? `${state.buildAgentMessages.length} message${state.buildAgentMessages.length > 1 ? 's' : ''}`
                  : 'Ready'}
              </span>
            </div>

            <div className="build-agent-chat" ref={scrollRef} onScroll={handleChatScroll}>
              {state.buildAgentMessages.length > 0 ? (
                state.buildAgentMessages.map((message, index) => (
                  <BuildMessage key={index} message={message} />
                ))
              ) : (
                <div className="build-agent-empty">
                  <div className="build-agent-empty-intro">
                    <span className="build-agent-empty-spark">✦</span>
                    <div>
                      <strong>Describe what you want to construct.</strong>
                      <p>The builder generates a 3D hologram blueprint at your current crosshair aim position.</p>
                    </div>
                  </div>
                  <div className="build-presets-heading">TRY AN INSPIRATION PROMPT:</div>
                  <div className="build-preset-chips">
                    {PROMPT_SUGGESTIONS.map(preset => (
                      <button
                        key={preset.title}
                        type="button"
                        tabIndex={-1}
                        className="build-preset-chip"
                        onClick={() => handleApplyPreset(preset.prompt)}
                      >
                        <span className="preset-chip-icon">{preset.icon}</span>
                        <span className="preset-chip-title">{preset.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="build-agent-input-row">
              <div className="build-agent-input-wrapper">
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={event => setPrompt(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Describe building or entity (e.g. 7x5 cottage with blue roof, dynamic rover...)"
                />
                <div className="build-input-hint">
                  <span><b>Enter</b> to generate</span>
                  <span>·</span>
                  <span><b>Shift+Enter</b> for new line</span>
                </div>
              </div>
              <button
                type="button"
                tabIndex={-1}
                className={`agent-send-btn ${state.buildAgentBusy ? 'loading' : ''}`}
                disabled={state.buildAgentBusy || !prompt.trim() || !!activeJob}
                onClick={() => void send()}
              >
                {state.buildAgentBusy ? (
                  <span className="btn-loading-dots">Thinking…</span>
                ) : (
                  <>
                    <span className="send-btn-spark">✦</span>
                    <span>Generate</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Right Column: Blueprint Review & Construction */}
          <div className="build-agent-review-column">
            <div className="build-column-header">
              <span className="build-column-title">BLUEPRINT &amp; VERIFICATION</span>
              {summary && state.buildValidation?.ok ? (
                <span className="build-badge-ready">HOLOGRAM ACTIVE</span>
              ) : null}
            </div>

            <div className="build-review-content">
              {summary && state.buildValidation?.ok ? (
                <div className="build-agent-plan-card">
                  <div className="build-plan-card-header">
                    <div>
                      <div className="build-agent-plan-name">{summary.name}</div>
                      <span className={`build-agent-plan-kind ${summary.kind}`}>
                        {summary.kind === 'entity' ? 'PHYSICS ENTITY' : 'WORLD STRUCTURE'}
                      </span>
                    </div>
                  </div>

                  <div className="build-agent-preview-hint flex items-center gap-1.5">
                    <span className="hologram-pulse-dot" />
                    <span>Cyan hologram preview projected at crosshair target.</span>
                  </div>

                  {/* High-Tech Specs Grid */}
                  <div className="build-specs-grid">
                    <div className="spec-tile">
                      <span className="spec-label flex items-center gap-1">
                        <LiaBoxesSolid size={12} /> Voxels
                      </span>
                      <span className="spec-val mono">{summary.voxelCount.toLocaleString()}</span>
                    </div>
                    <div className="spec-tile">
                      <span className="spec-label flex items-center gap-1">
                        <LiaCubeSolid size={12} /> Standard
                      </span>
                      <span className="spec-val mono">{summary.standardCount.toLocaleString()}</span>
                    </div>
                    <div className="spec-tile">
                      <span className="spec-label flex items-center gap-1">
                        <LiaCubesSolid size={12} /> Micro
                      </span>
                      <span className="spec-val mono">{summary.microCount.toLocaleString()}</span>
                    </div>
                    <div className="spec-tile">
                      <span className="spec-label flex items-center gap-1">
                        <LiaLayerGroupSolid size={12} /> Components
                      </span>
                      <span className="spec-val mono">{summary.componentCount}</span>
                    </div>
                    <div className="spec-tile">
                      <span className="spec-label flex items-center gap-1">
                        <LiaProjectDiagramSolid size={12} /> Scripts
                      </span>
                      <span className="spec-val mono">{summary.scriptCount}</span>
                    </div>
                    <div className="spec-tile">
                      <span className="spec-label flex items-center gap-1">
                        <LiaVectorSquareSolid size={12} /> Constraints
                      </span>
                      <span className="spec-val mono">{summary.constraintCount}</span>
                    </div>
                    <div className="spec-tile full-width">
                      <span className="spec-label flex items-center gap-1">
                        <LiaDraftingCompassSolid size={12} /> Bounds (W × H × D)
                      </span>
                      <span className="spec-val mono">
                        {summary.bounds?.size ? summary.bounds.size.map(value => `${Number(value.toFixed(1))}`).join(' × ') : '0 × 0 × 0'} m
                      </span>
                    </div>
                  </div>

                  {state.buildValidation.warnings.length > 0 ? (
                    <div className="build-agent-warnings-box">
                      {state.buildValidation.warnings.map(warning => (
                        <div key={warning} className="build-agent-warning flex items-start gap-1">
                          <LiaExclamationTriangleSolid size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                          <span>{warning}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="build-agent-review-actions">
                    <button
                      type="button"
                      tabIndex={-1}
                      className="banner-btn primary confirm-build-btn"
                      disabled={!!activeJob}
                      onClick={() => spaceUiStore.confirmBuildPlan()}
                    >
                      <LiaCheckSolid size={14} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />
                      Confirm &amp; Build
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      className="banner-btn secondary discard-build-btn"
                      onClick={() => spaceUiStore.cancelBuildPreview()}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ) : state.buildValidation && !state.buildValidation.ok ? (
                <div className="build-agent-errors-box">
                  <div className="build-errors-title flex items-center gap-1">
                    <LiaExclamationTriangleSolid size={14} /> Validation Failed
                  </div>
                  <ul className="build-errors-list">
                    {state.buildValidation.errors.map(error => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="build-agent-review-empty">
                  <div className="blueprint-wireframe-icon">
                    <LiaDraftingCompassSolid size={36} />
                  </div>
                  <div className="review-empty-title">AWAITING BLUEPRINT</div>
                  <div className="review-empty-desc">
                    Enter a description on the left. The AI compiler will validate physical voxel bounds and stream a hologram to your world.
                  </div>
                  <div className="review-empty-hint">
                    ✦ Aim crosshair at target surface before generating
                  </div>
                </div>
              )}

              <BuilderProgress />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
