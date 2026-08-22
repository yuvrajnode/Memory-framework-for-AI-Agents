import { useMemo } from 'react';

/**
 * Small inline SVG charts.
 *
 * Three chart types across one dashboard does not justify a plotting library,
 * and hand-drawn SVG inherits the theme's custom properties directly, so the
 * charts recolour with the rest of the interface rather than needing a
 * parallel palette.
 */

export interface Bar {
  label: string;
  value: number;
  color?: string;
}

export function BarChart({
  bars,
  height = 168,
  formatValue = (value: number) => String(value),
}: {
  bars: Bar[];
  height?: number;
  formatValue?: (value: number) => string;
}) {
  const max = Math.max(1, ...bars.map((bar) => bar.value));

  return (
    <div className="bar-chart" style={{ height }}>
      {bars.map((bar) => (
        <div key={bar.label} className="bar-chart__column">
          <span className="tabular xs faint">{formatValue(bar.value)}</span>
          <div
            className="bar-chart__bar"
            style={{
              // A floor of 2px keeps a zero-valued category visible as a
              // category rather than vanishing into the axis.
              height: `${Math.max(2, (bar.value / max) * 100)}%`,
              background: bar.color ?? 'var(--accent)',
            }}
            title={`${bar.label}: ${formatValue(bar.value)}`}
          />
          <span className="xs faint bar-chart__label">{bar.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A stacked proportion bar, for composition at a glance. */
export function ProportionBar({ segments }: { segments: Bar[] }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) {
    return <div className="proportion proportion--empty" aria-hidden="true" />;
  }
  return (
    <div className="proportion" role="img" aria-label="Composition by kind">
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <div
            key={segment.label}
            className="proportion__segment"
            style={{
              width: `${(segment.value / total) * 100}%`,
              background: segment.color ?? 'var(--accent)',
            }}
            title={`${segment.label}: ${segment.value} (${Math.round((segment.value / total) * 100)}%)`}
          />
        ))}
    </div>
  );
}

export interface Series {
  label: string;
  color: string;
  points: { x: number; y: number }[];
}

/**
 * A multi-series line chart on a fixed 0-1 y-axis.
 *
 * Used for the decay curves, where the y-axis is a retention fraction and a
 * shared, non-auto-scaled axis is the whole point — the comparison between
 * kinds is meaningless if each series is normalised to its own maximum.
 */
export function LineChart({
  series,
  xMax,
  xLabel,
  height = 220,
  markers = [],
}: {
  series: Series[];
  xMax: number;
  xLabel: string;
  height?: number;
  markers?: { x: number; label: string }[];
}) {
  const width = 640;
  const padding = { top: 12, right: 12, bottom: 28, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const scaleX = (x: number) => padding.left + (x / xMax) * plotWidth;
  const scaleY = (y: number) => padding.top + (1 - y) * plotHeight;

  const paths = useMemo(
    () =>
      series.map((entry) => ({
        ...entry,
        d: entry.points
          .map(
            (point, index) =>
              `${index === 0 ? 'M' : 'L'}${scaleX(point.x).toFixed(1)},${scaleY(point.y).toFixed(1)}`,
          )
          .join(' '),
      })),
    // scaleX/scaleY are derived from the props below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, xMax, height],
  );

  return (
    <div className="stack stack--tight">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto' }}
        role="img"
        aria-label={`Retention against ${xLabel} for ${series.map((s) => s.label).join(', ')}`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={scaleY(tick)}
              y2={scaleY(tick)}
              stroke="var(--rule)"
              strokeWidth={1}
            />
            <text
              x={padding.left - 6}
              y={scaleY(tick) + 3.5}
              textAnchor="end"
              fontSize={9}
              fill="var(--ink-faint)"
              fontFamily="var(--font-mono)"
            >
              {tick.toFixed(2)}
            </text>
          </g>
        ))}

        {markers.map((marker) => (
          <g key={marker.label}>
            <line
              x1={scaleX(marker.x)}
              x2={scaleX(marker.x)}
              y1={padding.top}
              y2={height - padding.bottom}
              stroke="var(--rule-strong)"
              strokeDasharray="3 3"
            />
            <text
              x={scaleX(marker.x) + 4}
              y={padding.top + 9}
              fontSize={9}
              fill="var(--ink-faint)"
              fontFamily="var(--font-mono)"
            >
              {marker.label}
            </text>
          </g>
        ))}

        {paths.map((entry) => (
          <path
            key={entry.label}
            d={entry.d}
            fill="none"
            stroke={entry.color}
            strokeWidth={1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        <text
          x={width / 2}
          y={height - 6}
          textAnchor="middle"
          fontSize={9}
          fill="var(--ink-faint)"
          fontFamily="var(--font-mono)"
        >
          {xLabel}
        </text>
      </svg>

      <div className="row row--tight row--wrap">
        {series.map((entry) => (
          <span key={entry.label} className="row row--tight xs faint">
            <span
              style={{
                width: 12,
                height: 2,
                background: entry.color,
                display: 'inline-block',
              }}
              aria-hidden="true"
            />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}
