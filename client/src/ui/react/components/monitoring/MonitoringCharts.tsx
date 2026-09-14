import React, { useState, useRef, useMemo } from 'react';
import { Icon } from '@iconify/react';

export interface ChartDataPoint {
  timestamp: string | number;
  datetime?: string;
  value: number | null;
  secondaryValue?: number | null;
}

interface AreaChartProps {
  data: ChartDataPoint[];
  title: string;
  unit: string;
  color: string;
  icon?: string;
  subTag?: string;
  secondaryColor?: string;
  secondaryLabel?: string;
  primaryLabel?: string;
  height?: number;
  yMin?: number;
  yMax?: number;
  thresholds?: { value: number; label: string; color: string }[];
  valueFormatter?: (val: number) => string;
}

export function MetricChart({
  data,
  title,
  unit,
  color,
  icon,
  subTag,
  secondaryColor,
  secondaryLabel,
  primaryLabel,
  height = 240,
  yMin: forcedYMin,
  yMax: forcedYMax,
  thresholds,
  valueFormatter = (v: number) => String(v),
}: AreaChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const containerRef = useRef<SVGSVGElement | null>(null);

  const { points, validMinY, validMaxY, xStep, primaryPath, areaPath, secondaryPath, scaleY } = useMemo(() => {
    if (!data || data.length === 0) {
      return { points: [], validMinY: 0, validMaxY: 100, xStep: 0, primaryPath: '', areaPath: '', secondaryPath: '', scaleY: (_v: number) => 0 };
    }

    const primaryVals = data.map(d => d.value).filter((v): v is number => v !== null && Number.isFinite(v));
    const secVals = secondaryColor
      ? data.map(d => d.secondaryValue).filter((v): v is number => v !== null && Number.isFinite(v))
      : [];
    const allVals = [...primaryVals, ...secVals];

    let computedMin = forcedYMin !== undefined ? forcedYMin : (allVals.length ? Math.min(...allVals) : 0);
    let computedMax = forcedYMax !== undefined ? forcedYMax : (allVals.length ? Math.max(...allVals) : 10);

    if (computedMin === computedMax) {
      computedMin = Math.max(0, computedMin - 5);
      computedMax = computedMax + 5;
    }
    // Add small headroom
    if (forcedYMax === undefined) {
      computedMax = Math.ceil(computedMax * 1.1) || 10;
    }

    const width = 800;
    const paddingLeft = 45;
    const paddingRight = 15;
    const paddingTop = 20;
    const paddingBottom = 30;

    const chartW = width - paddingLeft - paddingRight;
    const chartH = height - paddingTop - paddingBottom;
    const count = data.length;
    const step = count > 1 ? chartW / (count - 1) : chartW;

    const scaleY = (val: number) => {
      const norm = (val - computedMin) / (computedMax - computedMin || 1);
      return paddingTop + chartH - norm * chartH;
    };

    // Build primary line
    let pPath = '';
    let aPath = '';
    let started = false;
    let firstX = paddingLeft;
    let lastX = paddingLeft;

    data.forEach((d, idx) => {
      const x = paddingLeft + idx * step;
      if (d.value !== null && Number.isFinite(d.value)) {
        const y = scaleY(d.value);
        if (!started) {
          pPath += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
          firstX = x;
          started = true;
        } else {
          pPath += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
        }
        lastX = x;
      } else {
        started = false;
      }
    });

    if (pPath && !secondaryColor) {
      const bottomY = paddingTop + chartH;
      aPath = `${pPath} L ${lastX.toFixed(1)} ${bottomY} L ${firstX.toFixed(1)} ${bottomY} Z`;
    }

    // Build secondary line if provided
    let sPath = '';
    if (secondaryColor) {
      let sStarted = false;
      data.forEach((d, idx) => {
        const x = paddingLeft + idx * step;
        if (d.secondaryValue !== null && d.secondaryValue !== undefined && Number.isFinite(d.secondaryValue)) {
          const y = scaleY(d.secondaryValue);
          if (!sStarted) {
            sPath += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
            sStarted = true;
          } else {
            sPath += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
          }
        } else {
          sStarted = false;
        }
      });
    }

    return {
      points: data,
      validMinY: computedMin,
      validMaxY: computedMax,
      xStep: step,
      primaryPath: pPath,
      areaPath: aPath,
      secondaryPath: sPath,
      scaleY,
    };
  }, [data, forcedYMin, forcedYMax, height, secondaryColor]);

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!containerRef.current || points.length === 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const xPos = e.clientX - rect.left;
    const paddingLeft = 45;
    const paddingRight = 15;
    const width = 800;
    const chartW = width - paddingLeft - paddingRight;

    const relX = Math.max(0, Math.min(chartW, (xPos / rect.width) * width - paddingLeft));
    const index = Math.round(relX / (xStep || 1));
    if (index >= 0 && index < points.length) {
      setHoverIndex(index);
    }
  };

  const handlePointerLeave = () => {
    setHoverIndex(null);
  };

  const hoveredPoint = hoverIndex !== null && hoverIndex < points.length ? points[hoverIndex] : null;

  // Compute time labels
  const timeLabels = useMemo(() => {
    if (!data.length) return [];
    const ticks = 6;
    const labels: { label: string; x: number }[] = [];
    const paddingLeft = 45;
    const paddingRight = 15;
    const width = 800;
    const chartW = width - paddingLeft - paddingRight;
    const step = chartW / (ticks - 1);

    for (let i = 0; i < ticks; i++) {
      const idx = Math.min(data.length - 1, Math.round((i / (ticks - 1)) * (data.length - 1)));
      const item = data[idx];
      let str = '';
      if (item?.datetime) {
        const parts = item.datetime.split(' ');
        str = parts[1] ? parts[1].slice(0, 5) : '';
      } else if (item?.timestamp) {
        const d = new Date(typeof item.timestamp === 'number' ? item.timestamp * 1000 : item.timestamp);
        if (!Number.isNaN(d.getTime())) {
          str = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
      }
      labels.push({ label: str, x: paddingLeft + i * step });
    }
    return labels;
  }, [data]);

  // Compute Y ticks
  const yTicks = useMemo(() => {
    const ticks = 4;
    const list: { val: number; y: number }[] = [];
    const paddingTop = 20;
    const paddingBottom = 30;
    const chartH = height - paddingTop - paddingBottom;
    const span = validMaxY - validMinY || 1;

    for (let i = 0; i < ticks; i++) {
      const ratio = i / (ticks - 1);
      const val = validMinY + ratio * span;
      const y = paddingTop + chartH - ratio * chartH;
      list.push({ val: Math.round(val * 10) / 10, y });
    }
    return list;
  }, [validMinY, validMaxY, height]);

  const gradId = useMemo(() => `chart-grad-${title.replace(/[^a-zA-Z0-9]/g, '')}`, [title]);

  const paddingLeft = 45;
  const paddingRight = 15;
  const paddingTop = 20;
  const paddingBottom = 30;
  const width = 800;
  const chartH = height - paddingTop - paddingBottom;

  const hoverX = hoverIndex !== null ? paddingLeft + hoverIndex * xStep : null;

  return (
    <div className="space-metric-chart-card">
      <div className="space-metric-chart-header">
        <h4 className="space-metric-chart-title">
          {icon && <Icon icon={icon} className="space-chart-title-icon" />}
          {title}
        </h4>
        {subTag ? (
          <span className="space-metric-chart-subtag">{subTag}</span>
        ) : secondaryColor ? (
          <div className="space-metric-chart-legend">
            <span className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: color }} />
              {primaryLabel || 'Primary'}
            </span>
            <span className="legend-item">
              <span className="legend-dot" style={{ backgroundColor: secondaryColor }} />
              {secondaryLabel || 'Secondary'}
            </span>
          </div>
        ) : (
          <span className="space-metric-chart-subtag">{unit}</span>
        )}
      </div>

      <div className="space-metric-svg-wrapper">
        <svg
          ref={containerRef}
          viewBox={`0 0 ${width} ${height}`}
          className="space-metric-svg"
          preserveAspectRatio="none"
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0.0} />
            </linearGradient>
          </defs>

          {/* Background grid lines matching MonitorPage CartesianGrid */}
          {yTicks.map(tick => (
            <g key={`ytick-${tick.y}`}>
              <line
                x1={paddingLeft}
                y1={tick.y}
                x2={width - paddingRight}
                y2={tick.y}
                stroke="#ffffff0d"
                strokeDasharray="3 3"
              />
              <text
                x={paddingLeft - 8}
                y={tick.y + 3}
                fill="#ffffff40"
                fontSize="8"
                textAnchor="end"
                fontFamily="ui-monospace, monospace"
              >
                {tick.val}
              </text>
            </g>
          ))}

          {/* Threshold lines if any */}
          {thresholds?.map((t, i) => {
            if (t.value < validMinY || t.value > validMaxY) return null;
            const norm = (t.value - validMinY) / (validMaxY - validMinY || 1);
            const y = paddingTop + chartH - norm * chartH;
            return (
              <g key={`threshold-${i}`}>
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={width - paddingRight}
                  y2={y}
                  stroke={t.color}
                  strokeDasharray="3 3"
                  strokeOpacity="0.5"
                />
                <text
                  x={width - paddingRight - 4}
                  y={y - 4}
                  fill={t.color}
                  fontSize="8"
                  textAnchor="end"
                  fontFamily="ui-monospace, monospace"
                  opacity="0.8"
                >
                  {t.label}
                </text>
              </g>
            );
          })}

          {/* Area fill */}
          {areaPath && <path d={areaPath} fill={`url(#${gradId})`} />}

          {/* Primary curve */}
          {primaryPath && (
            <path
              d={primaryPath}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              strokeLinecap="square"
              strokeLinejoin="round"
            />
          )}

          {/* Secondary curve */}
          {secondaryPath && (
            <path
              d={secondaryPath}
              fill="none"
              stroke={secondaryColor}
              strokeWidth="1.5"
              strokeLinecap="square"
              strokeLinejoin="round"
            />
          )}

          {/* X Axis Time Labels */}
          {timeLabels.map((lbl, i) => (
            <text
              key={`xlabel-${i}`}
              x={lbl.x}
              y={height - 8}
              fill="#ffffff40"
              fontSize="8"
              textAnchor="middle"
              fontFamily="ui-monospace, monospace"
            >
              {lbl.label}
            </text>
          ))}

          {/* Hover crosshair */}
          {hoverX !== null && (
            <line
              x1={hoverX}
              y1={paddingTop}
              x2={hoverX}
              y2={paddingTop + chartH}
              stroke="#ffffff30"
              strokeDasharray="2 2"
              strokeWidth="1"
            />
          )}

          {/* Hover circle */}
          {hoverIndex !== null && hoveredPoint && hoveredPoint.value !== null && (
            <circle
              cx={paddingLeft + hoverIndex * xStep}
              cy={scaleY(hoveredPoint.value)}
              r="3"
              fill={color}
              stroke="#ffffff"
              strokeWidth="1"
            />
          )}
        </svg>

        {/* Hover Tooltip matching MonitorPage contentStyle */}
        {hoverIndex !== null && hoveredPoint && hoverX !== null && (
          <div
            className="space-chart-tooltip"
            style={{
              left: `${Math.min(85, Math.max(15, (hoverX / width) * 100))}%`,
              top: '12px',
            }}
          >
            <div className="tooltip-time">
              {hoveredPoint.datetime || String(hoveredPoint.timestamp)}
            </div>
            <div className="tooltip-val" style={{ color }}>
              {primaryLabel || title}:{' '}
              {hoveredPoint.value !== null ? valueFormatter(hoveredPoint.value) : '—'} {unit}
            </div>
            {secondaryColor && hoveredPoint.secondaryValue !== undefined && hoveredPoint.secondaryValue !== null && (
              <div className="tooltip-val" style={{ color: secondaryColor }}>
                {secondaryLabel || 'Secondary'}: {valueFormatter(hoveredPoint.secondaryValue)} {unit}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
