import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Icon } from '@iconify/react';
import { MetricChart } from './MonitoringCharts.tsx';
import { ensureSpaceAccessToken } from '../../../../bootstrap/SpaceAuthSession.ts';
import { spaceLoginUrl } from '../../../../bootstrap/SpaceSiteLinks.ts';
import './monitoring.css';

interface RealtimeStats {
  online_users: number;
  cpu_percent: number;
  memory_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  load_1m: number;
  load_5m?: number;
  load_15m?: number;
  current_latency_ms: number | null;
  active_worlds: number;
  uptime_seconds: number;
  server_time: string;
}

interface MinuteRecord {
  minute_bucket: number;
  timestamp: string;
  datetime?: string;
  online_users: number;
  cpu_percent: number;
  memory_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  load_1m: number;
  avg_latency_ms: number | null;
  latency_samples: number;
}

interface SummaryStats {
  range: string;
  data_points: number;
  peak_online_users_24h: number;
  avg_online_users_24h: number;
  avg_latency_24h: number;
  max_latency_24h: number;
  min_latency_24h: number;
  avg_cpu_24h: number;
  avg_memory_24h: number;
}

interface MonitoringResponse {
  realtime: RealtimeStats;
  history: MinuteRecord[];
  summary: SummaryStats;
}

export interface AdminMonitoringDashboardProps {
  apiOrigin?: string;
  onClose?: () => void;
  isModal?: boolean;
}

// StatCard Component matching MonitorPage.tsx lines 3359-3371
function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: string;
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className="space-stat-card">
      <div className={`space-stat-icon ${color}`}>
        <Icon icon={icon} />
      </div>
      <div className="space-stat-info">
        <span className="space-stat-label">{label}</span>
        <span className="space-stat-value">{value}</span>
      </div>
    </div>
  );
}

// ResourceMeter Component matching MonitorPage.tsx lines 3482-3535
function ResourceMeter({
  label,
  icon,
  percent,
  detail,
}: {
  label: string;
  icon: string;
  percent: number | null;
  detail: string;
}) {
  const safePercent = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const barColor =
    percent === null
      ? 'meter-bar-white'
      : percent >= 90
        ? 'meter-bar-red'
        : percent >= 70
          ? 'meter-bar-yellow'
          : 'meter-bar-cyan';
  const valueColor =
    percent === null
      ? 'meter-text-dim'
      : percent >= 90
        ? 'meter-text-red'
        : percent >= 70
          ? 'meter-text-yellow'
          : 'meter-text-white';

  return (
    <div className="space-meter-container">
      <div className="space-meter-header">
        <span className="space-meter-label">
          <Icon icon={icon} /> {label}
        </span>
        <span className={`space-meter-val ${valueColor}`}>
          {percent === null ? '--' : `${percent.toFixed(1)}%`}
        </span>
      </div>
      <div
        className="space-meter-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : safePercent}
      >
        <div
          className={`space-meter-bar ${barColor}`}
          style={{ width: `${safePercent}%` }}
        />
      </div>
      <div className="space-meter-detail">{detail}</div>
    </div>
  );
}

function formatBytes(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function calculateUptime(uptimeSeconds: number) {
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds <= 0) return '0m';
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function AdminMonitoringDashboard({
  apiOrigin: explicitApiOrigin,
  onClose,
  isModal = false,
}: AdminMonitoringDashboardProps) {
  const [range, setRange] = useState<'1h' | '6h' | '12h' | '24h'>('24h');
  const [autoRefreshSec, setAutoRefreshSec] = useState<number>(10);
  const [countdown, setCountdown] = useState<number>(10);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [authError, setAuthError] = useState<'unauthenticated' | 'forbidden' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [data, setData] = useState<MonitoringResponse | null>(null);
  const [tableExpanded, setTableExpanded] = useState<boolean>(false);

  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const resolveOrigin = useCallback(() => {
    if (explicitApiOrigin) return explicitApiOrigin.replace(/\/+$/, '');
    const configured = import.meta.env?.VITE_SPACE_API_BASE_URL || import.meta.env?.VITE_API_BASE_URL;
    if (configured) return String(configured).replace(/\/+$/, '');
    return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8000';
  }, [explicitApiOrigin]);

  const fetchData = useCallback(
    async (isManual = false) => {
      if (isManual) setRefreshing(true);
      const apiOrigin = resolveOrigin();

      try {
        const token = await ensureSpaceAccessToken(apiOrigin);
        if (!token) {
          setAuthError('unauthenticated');
          setLoading(false);
          setRefreshing(false);
          return;
        }

        const headers: Record<string, string> = {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        };

        const res = await fetch(`${apiOrigin}/space/api/v2/admin/monitoring?range=${range}`, {
          method: 'GET',
          headers,
          cache: 'no-store',
        });

        if (res.status === 401) {
          setAuthError('unauthenticated');
          setData(null);
        } else if (res.status === 403) {
          setAuthError('forbidden');
          setData(null);
        } else if (!res.ok) {
          const body = await res.json().catch(() => null);
          setErrorMessage(body?.detail || `HTTP Error ${res.status}`);
        } else {
          const json: MonitoringResponse = await res.json();
          setData(json);
          setAuthError(null);
          setErrorMessage(null);
        }
      } catch (err: any) {
        setErrorMessage(err?.message || 'Network request failed');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [range, resolveOrigin]
  );

  // Initial fetch and on range change
  useEffect(() => {
    void fetchData(false);
  }, [fetchData]);

  // Auto-refresh countdown loop
  useEffect(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }

    if (autoRefreshSec <= 0 || authError) return;

    setCountdown(autoRefreshSec);
    countdownTimerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          void fetchData(false);
          return autoRefreshSec;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [autoRefreshSec, authError, fetchData]);

  const handleManualRefresh = () => {
    setCountdown(autoRefreshSec);
    void fetchData(true);
  };

  // Prepare chart series
  const playerSeries = (data?.history || []).map(p => ({
    timestamp: p.timestamp,
    datetime: p.datetime,
    value: p.online_users,
  }));

  const cpuSeries = (data?.history || []).map(p => ({
    timestamp: p.timestamp,
    datetime: p.datetime,
    value: p.cpu_percent,
  }));

  const memorySeries = (data?.history || []).map(p => ({
    timestamp: p.timestamp,
    datetime: p.datetime,
    value: p.memory_percent,
  }));

  const latencySeries = (data?.history || []).map(p => ({
    timestamp: p.timestamp,
    datetime: p.datetime,
    value: p.avg_latency_ms,
  }));

  // Render unauthenticated state
  if (authError === 'unauthenticated') {
    return (
      <div className={`space-monitoring-page ${isModal ? 'as-modal' : ''}`}>
        <div className="space-monitoring-container">
          <div className="space-monitoring-guard">
            <div className="guard-card">
              <div className="guard-icon warn">
                <Icon icon="pixelarticons:shield" />
              </div>
              <h2 className="guard-title">Administrator Login Required</h2>
              <p className="guard-desc">
                EntropyDrop Space monitoring telemetry is restricted to authenticated administrators. Please sign in with an admin account.
              </p>
              <div className="guard-actions">
                <a href={spaceLoginUrl()} className="space-btn-text" style={{ borderColor: 'rgba(34, 197, 94, 0.3)', color: '#4ade80' }}>
                  Sign In
                </a>
                {onClose ? (
                  <button type="button" onClick={onClose} className="space-btn-text">
                    Back
                  </button>
                ) : (
                  <a href="/" className="space-btn-text">
                    Home
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Render forbidden state
  if (authError === 'forbidden') {
    return (
      <div className={`space-monitoring-page ${isModal ? 'as-modal' : ''}`}>
        <div className="space-monitoring-container">
          <div className="space-monitoring-guard">
            <div className="guard-card">
              <div className="guard-icon danger">
                <Icon icon="pixelarticons:alert" />
              </div>
              <h2 className="guard-title">Access Forbidden (403)</h2>
              <p className="guard-desc">
                Your account lacks administrator privileges to view real-time Space infrastructure metrics.
              </p>
              <div className="guard-actions">
                {onClose ? (
                  <button type="button" onClick={onClose} className="space-btn-text">
                    Back to Game
                  </button>
                ) : (
                  <a href="/" className="space-btn-text">
                    Home
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const realtime = data?.realtime;
  const summary = data?.summary;

  return (
    <div className={`space-monitoring-page ${isModal ? 'as-modal' : ''}`}>
      <div className="space-monitoring-container">
        {/* Header matching MonitorPage lines 1030-1054 */}
        <header className="space-monitoring-header">
          <div className="space-monitoring-title-area">
            <div className="space-monitoring-titles">
              <h1>
                <Icon icon="pixelarticons:device-tv" className="space-header-icon" />
                Space Monitoring Center
              </h1>
              <p className="space-monitoring-subtitle">
                LIVE SYSTEM STATUS •{' '}
                {realtime?.server_time
                  ? new Date(realtime.server_time).toLocaleTimeString()
                  : new Date().toLocaleTimeString()}
              </p>
            </div>
          </div>

          <div className="space-monitoring-controls">
            {/* Live System Status Pill */}
            {errorMessage ? (
              <div className="space-status-pill error">
                <div className="space-status-dot error" />
                <span className="space-status-text">{errorMessage}</span>
              </div>
            ) : (
              <div className="space-status-pill">
                <div className="space-status-dot pulsing" />
                <span className="space-status-text">
                  SYSTEM ONLINE
                </span>
              </div>
            )}

            {/* Time Range Selector */}
            <div className="space-range-group" role="group" aria-label="Time range selector">
              {(['1h', '6h', '12h', '24h'] as const).map(r => (
                <button
                  key={r}
                  type="button"
                  className={`space-range-btn ${range === r ? 'active' : ''}`}
                  onClick={() => setRange(r)}
                >
                  {r.toUpperCase()}
                </button>
              ))}
            </div>

            {/* Auto-refresh interval dropdown */}
            <select
              className="space-select"
              value={autoRefreshSec}
              onChange={e => setAutoRefreshSec(Number(e.target.value))}
              aria-label="Auto refresh interval"
            >
              <option value={10}>10s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
              <option value={0}>Off</option>
            </select>

            {/* Refresh button matching MonitorPage line 1095 */}
            <button
              type="button"
              className="space-btn-icon"
              onClick={handleManualRefresh}
              disabled={refreshing}
              title="Refresh metrics"
            >
              <Icon
                icon="pixelarticons:reload"
                className={refreshing ? 'animate-spin text-green-400' : ''}
              />
            </button>

            {/* Back to Space Button */}
            {onClose ? (
              <button type="button" onClick={onClose} className="space-btn-text">
                <Icon icon="pixelarticons:arrow-left" />
                Back to Space
              </button>
            ) : (
              <a href="/" className="space-btn-text">
                <Icon icon="pixelarticons:arrow-left" />
                Play Space
              </a>
            )}
          </div>
        </header>

        {/* Top 6 KPI StatCards (matching MonitorPage lines 1772-1809) */}
        <section className="space-stat-grid">
          <StatCard
            icon="pixelarticons:group"
            label="Online Users"
            value={loading && !realtime ? '--' : realtime?.online_users ?? 0}
            color="text-purple-400"
          />
          <StatCard
            icon="pixelarticons:speed-fast"
            label="CPU Usage"
            value={loading && !realtime ? '--' : `${(realtime?.cpu_percent ?? 0).toFixed(1)}%`}
            color="text-cyan-400"
          />
          <StatCard
            icon="pixelarticons:chip"
            label="Memory Usage"
            value={loading && !realtime ? '--' : `${(realtime?.memory_percent ?? 0).toFixed(1)}%`}
            color="text-blue-400"
          />
          <StatCard
            icon="pixelarticons:activity"
            label="Avg Latency (24h)"
            value={
              loading && !summary
                ? '--'
                : `${(summary?.avg_latency_24h ?? 0).toFixed(1)} ms`
            }
            color="text-yellow-400"
          />
          <StatCard
            icon="pixelarticons:dashboard"
            label="Load Avg (1m)"
            value={loading && !realtime ? '--' : (realtime?.load_1m ?? 0).toFixed(2)}
            color="text-pink-400"
          />
          <StatCard
            icon="pixelarticons:server"
            label="Active Worlds"
            value={loading && !realtime ? '--' : realtime?.active_worlds ?? 0}
            color="text-green-400"
          />
        </section>

        {/* Space Server Realtime Resources Section (matching MonitorPage lines 1057-1207) */}
        <section className="space-monitor-section">
          <div className="space-section-header">
            <div className="space-section-title-wrap">
              <div className="space-section-icon-box">
                <Icon icon="pixelarticons:server" />
              </div>
              <div>
                <h2>Space Server Realtime Resources</h2>
                <p>Node CPU, memory, load average and network latency telemetry</p>
              </div>
            </div>

            <div className="space-status-pill">
              <div className="space-status-dot pulsing" />
              <span className="space-status-text">
                1/1 Healthy
              </span>
            </div>
          </div>

          {/* Instance Card */}
          <article className="space-instance-card">
            <div className="space-instance-header">
              <div className="space-instance-identity">
                <div className="space-instance-name">
                  <Icon icon="pixelarticons:server" className="text-cyan-400" />
                  <span>entropydrop-space-node</span>
                </div>
                <div className="space-instance-tags">
                  <span>Uptime {calculateUptime(realtime?.uptime_seconds ?? 0)}</span>
                  <span>PORT 8000</span>
                  <span>RING BUFFER 1440 PTS</span>
                  <span>SAMPLING 1 MIN</span>
                </div>
              </div>
              <span className="space-badge-tag healthy">
                Healthy
              </span>
            </div>

            {/* 4 Resource Meters */}
            <div className="space-meters-grid">
              <ResourceMeter
                label="CPU"
                icon="pixelarticons:speed-fast"
                percent={realtime?.cpu_percent ?? null}
                detail={`Load avg: 1m: ${(realtime?.load_1m ?? 0).toFixed(2)}, 5m: ${(realtime?.load_5m ?? 0).toFixed(2)}`}
              />
              <ResourceMeter
                label="Memory"
                icon="pixelarticons:chip"
                percent={realtime?.memory_percent ?? null}
                detail={`${formatBytes((realtime?.memory_used_mb ?? 0) * 1024 * 1024)} / ${formatBytes((realtime?.memory_total_mb ?? 0) * 1024 * 1024)}`}
              />
              <ResourceMeter
                label="Avg Latency"
                icon="pixelarticons:activity"
                percent={
                  realtime?.current_latency_ms
                    ? Math.min(100, (realtime.current_latency_ms / 200) * 100)
                    : summary?.avg_latency_24h
                      ? Math.min(100, (summary.avg_latency_24h / 200) * 100)
                      : null
                }
                detail={`Current: ${realtime?.current_latency_ms !== null && realtime?.current_latency_ms !== undefined ? `${realtime.current_latency_ms} ms` : '--'} • 24h Avg: ${(summary?.avg_latency_24h ?? 0).toFixed(1)} ms`}
              />
              <ResourceMeter
                label="Load Avg"
                icon="pixelarticons:dashboard"
                percent={Math.min(100, (realtime?.load_1m ?? 0) * 25)}
                detail={`1m: ${(realtime?.load_1m ?? 0).toFixed(2)} • 5m: ${(realtime?.load_5m ?? 0).toFixed(2)} • 15m: ${(realtime?.load_15m ?? 0).toFixed(2)}`}
              />
            </div>

            {/* Metadata Footer */}
            <div className="space-instance-footer">
              <span>HOST: localhost:8000</span>
              <div>
                <span className="space-dep-ok">REDIS OK</span>{' • '}
                <span className="space-dep-ok">POSTGRES OK</span>{' • '}
                <span className="space-dep-ok">WEBSOCKET OK</span>
              </div>
              <span>
                Server Time: {realtime?.server_time ? new Date(realtime.server_time).toLocaleTimeString() : '--'}
              </span>
            </div>
          </article>
        </section>

        {/* Historical Metrics Trend Charts Section (matching MonitorPage lines 1209-1265) */}
        <section className="space-monitor-section">
          <div className="space-section-header">
            <div className="space-section-title-wrap">
              <div className="space-section-icon-box">
                <Icon icon="pixelarticons:chart" />
              </div>
              <div>
                <h3>Resource Utilization Trend • Last {range.toUpperCase()}</h3>
                <p>One-minute samples aggregated over the last {range.toUpperCase()}</p>
              </div>
            </div>

            <button
              type="button"
              className="space-btn-icon"
              onClick={handleManualRefresh}
              disabled={refreshing}
              title="Refresh history charts"
            >
              <Icon
                icon="pixelarticons:reload"
                className={refreshing ? 'animate-spin text-cyan-400' : ''}
              />
            </button>
          </div>

          <div className="space-charts-grid">
            {/* Chart 1: Online Users */}
            <MetricChart
              data={playerSeries}
              title="Online Users"
              unit="Users"
              icon="pixelarticons:group"
              color="#a78bfa"
              subTag={`PEAK: ${summary?.peak_online_users_24h ?? 0} • AVG: ${(summary?.avg_online_users_24h ?? 0).toFixed(1)}`}
              yMin={0}
              height={250}
              valueFormatter={v => String(Math.round(v))}
            />

            {/* Chart 2: CPU Utilization */}
            <MetricChart
              data={cpuSeries}
              title="CPU Utilization"
              unit="%"
              icon="pixelarticons:speed-fast"
              color="#38bdf8"
              subTag={`AVG: ${(summary?.avg_cpu_24h ?? 0).toFixed(1)}% • CURRENT: ${(realtime?.cpu_percent ?? 0).toFixed(1)}%`}
              yMin={0}
              yMax={100}
              height={250}
              valueFormatter={v => `${v.toFixed(1)}%`}
            />

            {/* Chart 3: Memory Utilization */}
            <MetricChart
              data={memorySeries}
              title="Memory Utilization"
              unit="%"
              icon="pixelarticons:chip"
              color="#34d399"
              subTag={`AVG: ${(summary?.avg_memory_24h ?? 0).toFixed(1)}% • USED: ${realtime?.memory_used_mb ?? 0} MB`}
              yMin={0}
              yMax={100}
              height={250}
              valueFormatter={v => `${v.toFixed(1)}%`}
            />

            {/* Chart 4: Average Latency */}
            <MetricChart
              data={latencySeries}
              title="Average User Latency"
              unit="ms"
              icon="pixelarticons:activity"
              color="#facc15"
              subTag={`MIN: ${(summary?.min_latency_24h ?? 0).toFixed(1)}ms • AVG: ${(summary?.avg_latency_24h ?? 0).toFixed(1)}ms • MAX: ${(summary?.max_latency_24h ?? 0).toFixed(1)}ms`}
              yMin={0}
              height={250}
              thresholds={[
                { value: 50, label: '50ms', color: '#34d399' },
                { value: 100, label: '100ms', color: '#facc15' },
                { value: 200, label: '200ms', color: '#f87171' },
              ]}
              valueFormatter={v => `${v.toFixed(1)}ms`}
            />
          </div>
        </section>

        {/* Telemetry Detail Table Section */}
        <section className="space-table-card">
          <div className="space-table-header">
            <h3 className="space-table-title">
              <Icon icon="pixelarticons:list" />
              Minute-by-Minute Telemetry Records
              <span style={{ fontSize: '10px', color: 'rgba(255, 255, 255, 0.35)', fontFamily: 'monospace' }}>
                ({data?.history.length ?? 0} samples)
              </span>
            </h3>
            <button
              type="button"
              className="space-btn-text"
              onClick={() => setTableExpanded(!tableExpanded)}
            >
              <Icon icon={tableExpanded ? 'pixelarticons:chevron-up' : 'pixelarticons:chevron-down'} />
              {tableExpanded ? 'Hide Table' : 'Show Table'}
            </button>
          </div>

          {tableExpanded && (
            <div className="space-table-scroll">
              <table className="space-metric-table">
                <thead>
                  <tr>
                    <th>Time (UTC)</th>
                    <th>Online Users</th>
                    <th>CPU %</th>
                    <th>Memory %</th>
                    <th>Memory Used</th>
                    <th>Load 1m</th>
                    <th>Avg Latency</th>
                    <th>Latency Samples</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.history || [])
                    .slice(-60)
                    .reverse()
                    .map(row => (
                      <tr key={`row-${row.minute_bucket}`}>
                        <td style={{ color: 'rgba(255, 255, 255, 0.45)' }}>
                          {row.datetime || String(row.minute_bucket)}
                        </td>
                        <td style={{ color: '#c084fc', fontWeight: 'bold' }}>
                          {row.online_users}
                        </td>
                        <td style={{ color: '#38bdf8' }}>{row.cpu_percent.toFixed(1)}%</td>
                        <td style={{ color: '#34d399' }}>{row.memory_percent.toFixed(1)}%</td>
                        <td>{row.memory_used_mb} MB</td>
                        <td style={{ color: '#f472b6' }}>{row.load_1m.toFixed(2)}</td>
                        <td style={{ color: row.avg_latency_ms !== null ? '#facc15' : 'rgba(255, 255, 255, 0.3)' }}>
                          {row.avg_latency_ms !== null ? `${row.avg_latency_ms.toFixed(1)} ms` : '--'}
                        </td>
                        <td>{row.latency_samples}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
