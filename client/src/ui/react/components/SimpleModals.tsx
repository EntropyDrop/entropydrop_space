import React from 'react';
import { SpaceAgentInstructions } from './SpaceAgentInstructions.tsx';
import { SPACE_HOSTING_UI_ENABLED } from '../../../bootstrap/SpaceFeatures.ts';
import { CharacterSkinPreview } from './CharacterSkinPreview.tsx';
import { LIGHTING_PRESETS, LIGHTING_QUALITY_LEVELS } from '../../../engine/render/LightingQuality.ts';
import { ENTITY_IMPOSTOR_SETTING_LIMITS } from '../../../engine/render/EntityImpostorSettings.ts';
import type { SpaceApiKeyRecord, SpaceApiUsage } from '../../../bootstrap/SpaceApiKeyClient.ts';
import {
  DISTANT_SURFACE_SETTING_LIMITS,
  type DistantSurfaceDistanceSettingKey,
  type DistantSurfaceEnabledSettingKey,
} from '@entropydrop/space-engine/render/DistantSurfaceLayer.ts';
import { spaceUiStore } from '../store/SpaceUiStore.ts';
import { useSpaceUi } from '../store/useSpaceUi.ts';
import { getAltKeyLabel } from '../../../bootstrap/SpaceBootstrap.ts';

const DISTANT_LOD_CONTROLS: ReadonlyArray<{
  distanceKey: DistantSurfaceDistanceSettingKey;
  enabledKey: DistantSurfaceEnabledSettingKey;
  label: string;
  description: string;
}> = [
    { distanceKey: 'lod2Distance', enabledKey: 'lod2Enabled', label: '2m Samples', description: 'Highest-detail snapshot radius' },
    { distanceKey: 'lod4Distance', enabledKey: 'lod4Enabled', label: '4m Samples', description: '4m → 8m transition distance' },
    { distanceKey: 'lod8Distance', enabledKey: 'lod8Enabled', label: '8m Samples', description: '8m → 16m transition distance' },
    { distanceKey: 'lod16Distance', enabledKey: 'lod16Enabled', label: '16m Samples', description: '16m → 32m transition distance' },
    { distanceKey: 'lod32Distance', enabledKey: 'lod32Enabled', label: '32m Samples', description: '32m → 64m transition distance' },
  ];

function ModalBackdrop({ id, className = '', children, onClose }: { id: string; className?: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div id={id} className={`custom-modal open ${className}`} onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      {children}
    </div>
  );
}

function SpaceApiKeysSettings() {
  const client = spaceUiStore.getApiKeyClient();
  const [keys, setKeys] = React.useState<SpaceApiKeyRecord[]>([]);
  const [name, setName] = React.useState('My external agent');
  const worldId = useSpaceUi(state => state.apiWorldId);
  const [usage, setUsage] = React.useState<SpaceApiUsage | null>(null);
  const [usageError, setUsageError] = React.useState('');
  const hostingAvailable = SPACE_HOSTING_UI_ENABLED && usage?.features?.entity_hosting === true;
  const [secret, setSecret] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');

  const load = React.useCallback(async () => {
    if (!client) return;
    try {
      setKeys(await client.list());
      setMessage('');
    } catch (error: any) {
      setMessage(error?.message || 'Could not load API keys.');
    }
  }, [client]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const loadUsage = React.useCallback(async () => {
    if (!client || !worldId) return;
    try {
      setUsage(await client.usage(worldId));
      setUsageError('');
    } catch (error: any) {
      setUsageError(error?.message || 'Could not load API allowances.');
    }
  }, [client, worldId]);

  React.useEffect(() => {
    let active = true;
    setUsage(null);
    void loadUsage();
    const refresh = () => { if (active && document.visibilityState === 'visible') void loadUsage(); };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [loadUsage]);

  const create = async () => {
    if (!client || !name.trim() || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const created = await client.create(name.trim());
      setSecret(created.api_key);
      setName('My external agent');
      await Promise.all([load(), loadUsage()]);
    } catch (error: any) {
      setMessage(error?.message || 'Could not create API key.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (apiKey: SpaceApiKeyRecord) => {
    if (!client || busy) return;
    if (!window.confirm(`Revoke API key “${apiKey.name}”? External agents using it will stop working immediately.`)) return;
    setBusy(true);
    setMessage('');
    try {
      await client.revoke(apiKey.id);
      await Promise.all([load(), loadUsage()]);
    } catch (error: any) {
      setMessage(error?.message || 'Could not revoke API key.');
    } finally {
      setBusy(false);
    }
  };

  if (!client) {
    return <><SpaceAgentInstructions /><div className="settings-api-empty">Sign in and enter online Space to manage API keys.</div></>;
  }

  return (
    <div className="settings-api-keys">
      <SpaceAgentInstructions />
      {usage ? <>
        <div className="settings-api-pricing">
          <div><strong>{usage.credits.toLocaleString()}</strong><span>Credit balance</span></div>
          {hostingAvailable ? <div><strong>{usage.pricing.hosting_credits_per_hour} credit / hour</strong><span>Hosted entity · each</span></div> : null}
          <div><strong>{usage.pricing.entity_create_credits === 0 && usage.pricing.blockset_build_credits === 0 ? 'Free' : `${usage.pricing.entity_create_credits} / ${usage.pricing.blockset_build_credits} credits`}</strong><span>Create entity / build blockset</span></div>
        </div>
        {hostingAvailable ? <p className="settings-desc">Hosting buys one hour when execution starts, then uses prepaid simulation time. Pauses and downtime preserve unused time. A spending budget is required (up to {usage.pricing.hosting_max_budget_credits} credits); prepaid time is used first, and hosting pauses if the next hour cannot be funded.</p> : null}
        <dl className="settings-api-allowances">
          {([
            ['API keys · account', usage.quotas.api_keys],
            ['Entities · this world', usage.quotas.entities],
            ['Running entities · you', usage.quotas.running_entities],
            ...(hostingAvailable ? [['Hosted entities · entire world', usage.quotas.hosted_entities_world] as const] : []),
            ['Terrain changes · this UTC hour', usage.quotas.terrain.hour],
            ['Terrain changes · today (UTC)', usage.quotas.terrain.day],
          ] as const).map(([label, quota]) => <div key={label}>
            <dt>{label}</dt><dd><strong>{quota.remaining.toLocaleString()} remaining</strong><span>{quota.used.toLocaleString()} / {quota.limit.toLocaleString()} used</span></dd>
          </div>)}
          <div><dt>Entity storage · this world</dt><dd>{(usage.quotas.entity_storage_bytes.used / 1048576).toFixed(1)} / {(usage.quotas.entity_storage_bytes.limit / 1048576).toFixed(0)} MiB</dd></div>
        </dl>
        <div className="settings-desc">Terrain allowance is shared by manual edits and API builds{hostingAvailable ? ', including hosted scripts' : ''}. Daily reset: {new Date(usage.quotas.terrain.day.reset_at).toLocaleString()}.</div>
        <div className="settings-desc">Build: up to {usage.limits.blockset_blocks_per_build.toLocaleString()} voxels, {usage.limits.terrain_chunks_per_build} chunks and {usage.limits.terrain_zones_per_build} zones per request. Build / create endpoints: {usage.limits.build_requests_per_minute} requests/minute, {usage.limits.build_requests_per_hour}/hour each.{hostingAvailable ? ` Hosting: ${usage.limits.hosted_blocks_per_entity} voxels and ${usage.limits.hosted_components_per_entity} components per entity.` : ''}</div>
        {usage.admin_quota_exemptions ? <div className="settings-desc">Administrator exemptions apply to terrain, entity storage, and running-entity quotas. Other limits still apply.</div> : null}
        <div className="settings-api-refresh"><span className="settings-desc">Updated {new Date(usage.updated_at).toLocaleTimeString()}</span><button className="small-btn" onClick={() => void loadUsage()}>Refresh allowance</button></div>
      </> : <div className="settings-api-empty">{worldId ? 'Loading pricing and allowances…' : 'Enter an online world to view pricing and allowances.'}</div>}
      {usageError ? <div className="settings-api-message" role="status">{usageError} <button className="small-btn" onClick={() => void loadUsage()}>Retry</button></div> : null}
      <div className="settings-section-title">API KEYS</div>
      <div className="settings-api-create">
        <input
          className="settings-api-name"
          value={name}
          maxLength={80}
          aria-label="API key name"
          onChange={event => setName(event.target.value)}
          placeholder="Key name"
        />
        <span className="settings-desc">All Space permissions included</span>
        <button className="small-btn primary" disabled={busy || !name.trim()} onClick={() => void create()}>
          {busy ? 'Working…' : 'Create key'}
        </button>
      </div>
      {secret ? (
        <div className="settings-api-secret">
          <strong>Copy this key now. It will not be shown again.</strong>
          <div className="settings-api-secret-row">
            <input readOnly value={secret} aria-label="New spaceAPI key" onFocus={event => event.currentTarget.select()} />
            <button className="small-btn" onClick={() => {
              if (!navigator.clipboard?.writeText) {
                setMessage('Clipboard access is unavailable. Select the key and copy it manually.');
                return;
              }
              void navigator.clipboard.writeText(secret).then(
                () => setMessage('API key copied.'),
                () => setMessage('Copy failed. Select the key and copy it manually.'),
              );
            }}>Copy</button>
          </div>
        </div>
      ) : null}
      {message ? <div className="settings-api-message" role="status">{message}</div> : null}
      <div className="settings-api-list">
        {keys.length === 0 ? <div className="settings-api-empty">No API keys yet.</div> : keys.map(apiKey => (
          <div className="settings-api-key" key={apiKey.id}>
            <div>
              <div className="settings-api-key-name">{apiKey.name}</div>
              <div className="settings-api-key-meta">
                <code>{apiKey.key_prefix}…</code>
                <span>All Space permissions</span>
                <span>Last used: {apiKey.last_used_at ? new Date(apiKey.last_used_at).toLocaleString() : 'never'}</span>
              </div>
            </div>
            <button className="small-btn settings-api-revoke" disabled={busy} onClick={() => void revoke(apiKey)}>Revoke</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GlobalSettingsModal() {
  const state = useSpaceUi(snapshot => snapshot);
  const [tab, setTab] = React.useState<'character' | 'graphics' | 'sound' | 'api'>('character');
  if (state.activeModal !== 'settings') return null;
  const distantLodDisabled = state.worldShapeMode === 'earth';
  return (
    <ModalBackdrop id="global-settings-modal" onClose={() => spaceUiStore.toggleGlobalSettingsModal(false)}>
      <div className="modal-content settings-modal-content">
        <div className="modal-header"><h2>Global Settings</h2><button id="close-global-settings-btn" tabIndex={-1} className="icon-btn" style={{ width: 28, height: 28, fontSize: 13 }} title="Close settings (ESC)" onClick={() => spaceUiStore.toggleGlobalSettingsModal(false)}>✕</button></div>
        <div className="modal-sub">Your character, world preferences, and external API</div>
        <div className="settings-tabs" role="tablist" aria-label="Settings categories">
          {(['character', 'graphics', 'sound', 'api'] as const).map((value, index, tabs) => <button
            key={value} id={`settings-tab-${value}`} role="tab" aria-selected={tab === value}
            aria-controls={`settings-panel-${value}`} tabIndex={tab === value ? 0 : -1}
            className={`settings-tab ${tab === value ? 'active' : ''}`} onClick={() => setTab(value)}
            onKeyDown={event => {
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              setTab(tabs[next]);
              (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
            }}
          >{{ character: 'Character', graphics: 'Graphics', sound: 'Sound', api: 'API' }[value]}</button>)}
        </div>
        <div className="settings-tab-panel" role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
          {tab === 'character' ? <>
            {state.currentSkin ? <section className="settings-section settings-character-card">
              <div className="settings-section-title">CURRENT SKIN</div>
              <CharacterSkinPreview url={state.currentSkin.url} model={state.currentSkin.model} />
              <div className="settings-label">{state.currentSkin.model === 'slim' ? 'Slim' : 'Strong'} character</div>
              <div className="settings-desc">This is the skin currently in use. Select a skin in Collection, choose Set as My Skin, then reload Space.</div>
              <div className="settings-skin-actions"><a className="small-btn primary settings-skin-link" href="/skin/collection" target="_blank" rel="noopener noreferrer">Change Skin</a></div>
            </section> : null}
            {state.skinWarning || !state.currentSkin ? (
              <section className="settings-skin-warning" aria-labelledby="settings-skin-warning-title">
                <div className="settings-skin-warning-heading">
                  <span className="settings-skin-warning-icon" aria-hidden="true">!</span>
                  <div>
                    <div id="settings-skin-warning-title" className="settings-skin-warning-title">Set up your character skin</div>
                    <div className="settings-skin-warning-message">{state.skinWarning || 'No character skin is configured, so the default skin is in use.'}</div>
                  </div>
                </div>
                <ol className="settings-skin-steps">
                  <li>Open Collection to upload a skin or choose one you already have.</li>
                  <li>Alternatively, create a new skin on the Generate page.</li>
                  <li>Open the chosen skin's detail page and select <strong>Set as My Skin</strong>.</li>
                  <li>Return to Space and reload to use the new skin.</li>
                </ol>
                <div className="settings-skin-actions">
                  <a className="small-btn primary settings-skin-link" href="/skin/collection" target="_blank" rel="noopener noreferrer">
                    Open Collection
                  </a>
                  <a className="small-btn settings-skin-link" href="/skin/generate" target="_blank" rel="noopener noreferrer">
                    Generate a Skin
                  </a>
                </div>
              </section>
            ) : null}
          </> : null}
          {tab === 'graphics' ? <>
            <div className="settings-section">
              <div className="settings-section-title">CAMERA &amp; VIEW</div>
              <div className="settings-row">
                <div className="settings-label-group"><span className="settings-label">Field of View (FOV)</span><span className="settings-desc">Camera lens angle (50° ~ 110°)</span></div>
                <div className="settings-control-group"><input id="setting-fov-slider" className="settings-slider" type="range" min="50" max="110" step="1" value={state.fov} onChange={event => spaceUiStore.setFov(Number(event.target.value))} /><span id="setting-fov-val" className="settings-value-badge">{state.fov}°</span></div>
              </div>
              <div className="settings-row">
                <div className="settings-label-group"><span className="settings-label">Perspective</span><span className="settings-desc">Cycle First, Third Back, and Third Front views (F3)</span></div>
                <div className="settings-segmented-control" id="setting-perspective-group">
                  {([
                    ['first_person', '1st Person'],
                    ['third_person', '3rd Back'],
                    ['third_person_front', '3rd Front']
                  ] as const).map(([value, label]) => <button key={value} tabIndex={-1} className={`segment-btn ${state.perspective === value ? 'active' : ''}`} onClick={() => spaceUiStore.setPerspective(value)}>{label}</button>)}
                </div>
              </div>
              <div className="settings-row" id="setting-cam-dist-row" style={{ display: state.perspective === 'first_person' ? 'none' : 'flex' }}>
                <div className="settings-label-group"><span className="settings-label">Third Person Distance</span><span className="settings-desc">Camera offset distance from player</span></div>
                <div className="settings-control-group"><input id="setting-cam-dist-slider" className="settings-slider" type="range" min="2" max="8" step="0.5" value={state.cameraDistance} onChange={event => spaceUiStore.setCameraDistance(Number(event.target.value))} /><span id="setting-cam-dist-val" className="settings-value-badge">{state.cameraDistance.toFixed(1)} m</span></div>
              </div>
              <div className="settings-row">
                <div className="settings-label-group"><span className="settings-label">Minimap</span><span className="settings-desc">Continuously updates nearby terrain and entities · may reduce performance while moving</span></div>
                <div className="settings-segmented-control" id="setting-minimap-group">
                  {([
                    [true, 'Enabled'],
                    [false, 'Disabled']
                  ] as const).map(([value, label]) => (
                    <button
                      key={String(value)}
                      tabIndex={-1}
                      className={`segment-btn ${state.minimapEnabled === value ? 'active' : ''}`}
                      aria-pressed={state.minimapEnabled === value}
                      onClick={() => spaceUiStore.setMinimapEnabled(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-section-title">WORLD &amp; ENVIRONMENT</div>
              <div className="settings-row">
                <div className="settings-label-group"><span className="settings-label">World Shape</span><span className="settings-desc">Switch between a spherical horizon and the original ring world</span></div>
                <div className="settings-segmented-control" id="setting-world-shape-group">
                  {([
                    ['earth', 'Earth Mode'],
                    ['torus', 'Donut Mode']
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      tabIndex={-1}
                      className={`segment-btn ${state.worldShapeMode === value ? 'active' : ''}`}
                      aria-pressed={state.worldShapeMode === value}
                      onClick={() => spaceUiStore.setWorldShapeMode(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-section-title">PERFORMANCE</div>
              <div className="settings-row settings-lighting-row">
                <div className="settings-label-group">
                  <span className="settings-label" id="setting-lighting-label">Lighting Quality</span>
                  <span className="settings-desc" id="setting-lighting-description" aria-live="polite">
                    {LIGHTING_PRESETS[state.lightingQuality].description}
                    {state.lightingQuality !== 'low' && state.resolutionEffectsQuality === 'reduced'
                      ? (state.lightingQuality === 'ultra'
                        ? ' · Auto has paused bloom, sun rays and contact shadows; cinematic sky and color remain'
                        : ' · Auto resolution has temporarily reduced effects; your selected quality is saved')
                      : ''}
                  </span>
                </div>
                <div
                  className="settings-segmented-control settings-lighting-control"
                  id="setting-lighting-quality-group"
                  role="group"
                  aria-labelledby="setting-lighting-label"
                  aria-describedby="setting-lighting-description"
                >
                  {LIGHTING_QUALITY_LEVELS.map(quality => (
                    <button
                      key={quality}
                      className={`segment-btn ${state.lightingQuality === quality ? 'active' : ''}`}
                      aria-pressed={state.lightingQuality === quality}
                      title={LIGHTING_PRESETS[quality].description}
                      onClick={() => spaceUiStore.setLightingQuality(quality)}
                    >
                      {LIGHTING_PRESETS[quality].label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-label-group">
                  <span className="settings-label">Shadows</span>
                  <span className="settings-desc">{state.lightingQuality === 'low'
                    ? 'Paused at Low lighting quality · select Medium or higher to use shadows'
                    : `Render real-time sunlight shadows${state.shadowsEnabled && state.resolutionEffectsQuality === 'reduced' ? ' · temporarily paused by Auto resolution' : ''}`}</span>
                </div>
                <div className="settings-segmented-control" id="setting-shadows-group">
                  {([
                    [true, 'Enabled'],
                    [false, 'Disabled']
                  ] as const).map(([value, label]) => (
                    <button
                      key={String(value)}
                      tabIndex={-1}
                      className={`segment-btn ${state.shadowsEnabled === value ? 'active' : ''}`}
                      disabled={state.lightingQuality === 'low'}
                      aria-pressed={state.shadowsEnabled === value}
                      onClick={() => spaceUiStore.setShadowsEnabled(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row settings-resolution-row">
                <div className="settings-label-group">
                  <span className="settings-label">Render Resolution</span>
                  <span className="settings-desc">Auto targets {state.resolutionTargetFps} FPS{state.lightingQuality === 'ultra' ? ' for cinematic lighting' : ''} · currently {Math.round(state.resolutionScale * 100)}% ({state.resolutionPixelRatio.toFixed(2)}× pixel ratio){state.resolutionEffectsQuality === 'reduced' ? ' · effects reduced' : ''}</span>
                </div>
                <div className="settings-segmented-control settings-resolution-control" id="setting-resolution-group">
                  {([
                    ['auto', 'Auto'],
                    ['1', '100%'],
                    ['0.8', '80%'],
                    ['0.67', '67%'],
                    ['0.5', '50%']
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      tabIndex={-1}
                      className={`segment-btn ${state.resolutionScaleMode === value ? 'active' : ''}`}
                      aria-pressed={state.resolutionScaleMode === value}
                      onClick={() => spaceUiStore.setResolutionScale(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-label-group"><span className="settings-label">Chunk Render Distance</span><span className="settings-desc">Voxel terrain mesh streaming radius (4 ~ 20 chunks)</span></div>
                <div className="settings-control-group"><input id="setting-render-dist-slider" className="settings-slider" type="range" min="4" max="20" step="1" value={state.renderDistance} onChange={event => spaceUiStore.setRenderDistance(Number(event.target.value))} /><span id="setting-render-dist-val" className="settings-value-badge">{state.renderDistance} Chunks</span></div>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-section-title">
                ENTITY CROSS-PLANE LOD
              </div>
              <div className="settings-row">
                <div className="settings-label-group">
                  <label className="settings-label" htmlFor="setting-entity-impostor-start-slider">Entity Plane Start Distance</label>
                  <span className="settings-desc">Switch loaded entities to crossed planes beyond this distance; editing keeps full detail</span>
                </div>
                <div className="settings-control-group">
                  <input id="setting-entity-impostor-start-slider" className="settings-slider" type="range"
                    {...ENTITY_IMPOSTOR_SETTING_LIMITS.startDistance} value={state.entityImpostorSettings.startDistance}
                    onChange={event => spaceUiStore.setEntityImpostorSetting('startDistance', Number(event.target.value))} />
                  <span className="settings-value-badge">{state.entityImpostorSettings.startDistance} m</span>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-label-group">
                  <label className="settings-label" htmlFor="setting-entity-impostor-limit-slider">Entity Plane View Distance</label>
                  <span className="settings-desc">Keep previously loaded entity silhouettes beyond the chunk AOI; independent of terrain LOD</span>
                </div>
                <div className="settings-control-group">
                  <input id="setting-entity-impostor-limit-slider" className="settings-slider" type="range"
                    {...ENTITY_IMPOSTOR_SETTING_LIMITS.maxDistance}
                    min={Math.max(ENTITY_IMPOSTOR_SETTING_LIMITS.maxDistance.min, Math.ceil((state.entityImpostorSettings.startDistance + 100) / 100) * 100)}
                    value={state.entityImpostorSettings.maxDistance}
                    onChange={event => spaceUiStore.setEntityImpostorSetting('maxDistance', Number(event.target.value))} />
                  <span className="settings-value-badge">{state.entityImpostorSettings.maxDistance} m</span>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-label-group"><span className="settings-desc">Works in Earth and Donut modes · takes effect immediately and saves automatically</span></div>
                <button className="small-btn" onClick={() => spaceUiStore.resetEntityImpostorSettings()}>Reset Entity LOD</button>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-section-title">
                DISTANT TERRAIN LOD{distantLodDisabled ? ' · OFF IN EARTH MODE' : ''}
              </div>
              {DISTANT_LOD_CONTROLS.map(({ distanceKey, enabledKey, label, description }) => {
                const limits = DISTANT_SURFACE_SETTING_LIMITS[distanceKey];
                const enabled = !distantLodDisabled && state.distantSurfaceSettings[enabledKey];
                return (
                  <div className="settings-row" key={distanceKey}>
                    <div className="settings-label-group">
                      <span className="settings-label">{label}</span>
                      <span className="settings-desc">{description} · thresholds remain at least 50m apart</span>
                    </div>
                    <div className="settings-control-group">
                      <button
                        className={`mini-toggle-btn ${enabled ? 'active' : ''}`}
                        aria-pressed={enabled}
                        disabled={distantLodDisabled}
                        onClick={() => spaceUiStore.setDistantSurfaceSetting(enabledKey, !enabled)}
                      >
                        {enabled ? 'ON' : 'OFF'}
                      </button>
                      <input
                        id={`setting-${distanceKey}-slider`}
                        className="settings-slider"
                        type="range"
                        min={limits.min}
                        max={limits.max}
                        step={limits.step}
                        value={state.distantSurfaceSettings[distanceKey]}
                        disabled={!enabled || distantLodDisabled}
                        onChange={event => spaceUiStore.setDistantSurfaceSetting(distanceKey, Number(event.target.value))}
                      />
                      <span className="settings-value-badge">{state.distantSurfaceSettings[distanceKey]} m</span>
                    </div>
                  </div>
                );
              })}
              <div className="settings-row">
                <div className="settings-label-group">
                  <span className="settings-label">64m Samples</span>
                  <span className="settings-desc">Coarsest tier, used after the 32m threshold up to the surface limit</span>
                </div>
                <div className="settings-control-group">
                  <button
                    className={`mini-toggle-btn ${!distantLodDisabled && state.distantSurfaceSettings.lod64Enabled ? 'active' : ''}`}
                    aria-pressed={!distantLodDisabled && state.distantSurfaceSettings.lod64Enabled}
                    disabled={distantLodDisabled}
                    onClick={() => spaceUiStore.setDistantSurfaceSetting(
                      'lod64Enabled',
                      !state.distantSurfaceSettings.lod64Enabled,
                    )}
                  >
                    {!distantLodDisabled && state.distantSurfaceSettings.lod64Enabled ? 'ON' : 'OFF'}
                  </button>
                  <span className="settings-value-badge">64 m</span>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-label-group">
                  <span className="settings-label">Far Surface Limit</span>
                  <span className="settings-desc">Render no snapshot terrain beyond this distance</span>
                </div>
                <div className="settings-control-group">
                  <input
                    id="setting-far-surface-limit-slider"
                    className="settings-slider"
                    type="range"
                    min={Math.max(
                      DISTANT_SURFACE_SETTING_LIMITS.maxDistance.min,
                      state.distantSurfaceSettings.lod32Distance + 50,
                    )}
                    max={DISTANT_SURFACE_SETTING_LIMITS.maxDistance.max}
                    step={DISTANT_SURFACE_SETTING_LIMITS.maxDistance.step}
                    value={state.distantSurfaceSettings.maxDistance}
                    disabled={distantLodDisabled}
                    onChange={event => spaceUiStore.setDistantSurfaceSetting('maxDistance', Number(event.target.value))}
                  />
                  <span className="settings-value-badge">{state.distantSurfaceSettings.maxDistance} m</span>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-label-group">
                  <span className="settings-label">Neighbor Connections</span>
                  <span className="settings-desc">Connect height differences up to this distance; 0 disables connections</span>
                </div>
                <div className="settings-control-group">
                  <input
                    id="setting-connection-distance-slider"
                    className="settings-slider"
                    type="range"
                    min={DISTANT_SURFACE_SETTING_LIMITS.connectionDistance.min}
                    max={DISTANT_SURFACE_SETTING_LIMITS.connectionDistance.max}
                    step={DISTANT_SURFACE_SETTING_LIMITS.connectionDistance.step}
                    value={state.distantSurfaceSettings.connectionDistance}
                    disabled={distantLodDisabled}
                    onChange={event => spaceUiStore.setDistantSurfaceSetting('connectionDistance', Number(event.target.value))}
                  />
                  <span className="settings-value-badge">
                    {state.distantSurfaceSettings.connectionDistance === 0
                      ? 'Off'
                      : `${state.distantSurfaceSettings.connectionDistance} m`}
                  </span>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-label-group">
                  <span className="settings-desc">Recommended: all tiers on · 400 / 600 / 800 / 1000 / 1600m · full-world limit · connections 4000m</span>
                </div>
                <button className="small-btn" disabled={distantLodDisabled} onClick={() => spaceUiStore.resetDistantSurfaceSettings()}>
                  Reset Recommended
                </button>
              </div>
            </div>
          </> : null}
          {tab === 'sound' ? <div className="settings-section">
            <div className="settings-section-title">AUDIO &amp; SOUND</div>
            <div className="settings-row">
              <div className="settings-label-group"><span className="settings-label">Background Music</span><span className="settings-desc">Play the Space soundtrack; disabled by default</span></div>
              <div className="settings-segmented-control" id="setting-music-group">
                {([
                  [false, 'Off'],
                  [true, 'On']
                ] as const).map(([value, label]) => (
                  <button
                    key={String(value)}
                    tabIndex={-1}
                    className={`segment-btn ${state.musicEnabled === value ? 'active' : ''}`}
                    onClick={() => spaceUiStore.setMusicEnabled(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-label-group"><span className="settings-label">Sound Effects</span><span className="settings-desc">Block, tool, mechanical, and physics sounds</span></div>
              <div className="settings-segmented-control" id="setting-effects-group">
                {([
                  [true, 'On'],
                  [false, 'Off']
                ] as const).map(([value, label]) => (
                  <button
                    key={String(value)}
                    tabIndex={-1}
                    className={`segment-btn ${state.effectsEnabled === value ? 'active' : ''}`}
                    onClick={() => spaceUiStore.setEffectsEnabled(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
            : null}
          {tab === 'api' ? <div className="settings-section">
            <div className="settings-section-title">spaceAPI · AGENT ACCESS</div>
            <div className="settings-desc">All API keys include full Space permissions: read your position, create and edit your entities, start/stop them, and build blocksets in worlds you can access.{SPACE_HOSTING_UI_ENABLED ? ' Hosted entity execution is also available.' : ''} Existing keys have the same full access. Keep them secret and revoke unused keys.</div>
            <SpaceApiKeysSettings />
          </div> : null}
        </div>
      </div>
    </ModalBackdrop>
  );
}

export function PauseScreen() {
  const hasStarted = useSpaceUi(state => state.hasStarted);
  const altLabel = getAltKeyLabel();
  return (
    <div id="pause-screen" className={hasStarted ? 'hidden' : ''}>
      <div className="hero-box">
        <div className="hero-block-icon">■</div>
        <h1 className="game-logo">EntropyDrop · Space <span className="game-logo-beta">BETA</span></h1>
        <div className="controls-guide">
          <span><kbd className="key-badge">W</kbd><kbd className="key-badge">A</kbd><kbd className="key-badge">S</kbd><kbd className="key-badge">D</kbd> Move / Drive</span>
          <span><kbd className="key-badge">Space</kbd> Jump / Ascend</span>
          <span><kbd className="key-badge">{altLabel}+1-9</kbd> Palette color · <kbd className="key-badge">I</kbd> Set color</span>
          <span><kbd className="key-badge">E</kbd> Backpack / Color sets</span>
          <span><kbd className="key-badge">1</kbd> Shovel: remove / place 1m blocks</span>
          <span><kbd className="key-badge">2</kbd> Spoon: micro-carve 8x8x8</span>
          <span><kbd className="key-badge">3</kbd> Selector: select region · Arrows rotate · Tab standard/micro blocks · R copy</span>
          <span><kbd className="key-badge">4</kbd> Hammer: LMB build / attach to entity · RMB / Arrows rotate</span>
          <span><kbd className="key-badge">5</kbd> Wrench: show pivot XYZ axes · hold LMB to stop & lift · RMB to start</span>
          <span><kbd className="key-badge">6</kbd> Brush: paint / right-click 2-point dye · Tab micro/standard</span>
          <span><kbd className="key-badge">Shift+Click</kbd> Multi-select component blocks</span>
          <span><kbd className="key-badge">C</kbd> Entity editor</span>
          <span><kbd className="key-badge">G</kbd> Assemble physics entity</span>
          <span><kbd className="key-badge">V</kbd> Mount / leave entity seat</span>
          <span><kbd className="key-badge">F</kbd> Fly mode</span>
          <span><kbd className="key-badge">F3</kbd> Cycle 1st / 3rd Back / 3rd Front</span>
          <span><kbd className="key-badge">ESC</kbd> Settings / release cursor</span>
        </div>
        <button id="start-btn" tabIndex={-1} className="start-btn" onClick={() => spaceUiStore.startGame()}>Enter Space</button>
      </div>
    </div>
  );
}
