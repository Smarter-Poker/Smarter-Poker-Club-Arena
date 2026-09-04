/**
 * One labelled value in a stats grid. Moved verbatim out of PlayerStatsPage.tsx
 * (Stats Page Programme phase 2) so every tab chunk can use it.
 */
export function StatRow({
  label,
  value,
  highlight,
  color = '#00d4ff',
}: {
  label: string;
  value: string;
  highlight?: boolean;
  color?: string;
}) {
  return (
    <div className={`stat-row ${highlight ? 'highlight' : ''}`}>
      <span className="row-label">
        <span className="row-dot" style={{ backgroundColor: color }} />
        {label}
      </span>
      <span className="row-value" style={{ color }}>
        {value}
      </span>
    </div>
  );
}
