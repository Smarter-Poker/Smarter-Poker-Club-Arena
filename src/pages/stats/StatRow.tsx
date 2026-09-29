/**
 * One labelled value in a stats grid. Moved verbatim out of PlayerStatsPage.tsx
 * (Stats Page Programme phase 2) so every tab chunk can use it.
 */
export function StatRow({
  label,
  value,
  highlight,
  color = '#00d4ff',
  scope,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  color?: string;
  /**
   * WHICH GAMES THIS FIGURE COUNTS (Stats contract truth, 2026-09-20).
   *
   * ca_player_stats_overview_v2 builds one payload out of two populations:
   * the money columns are computed `FILTER (WHERE is_cash)` while VPIP, PFR,
   * hands won, WTSD, the showdown split and the aggression factor count every
   * hand, tournament included. The grids rendered both in one unmarked list,
   * so a player with 400 cash hands and 9,000 tournament hands read "Total
   * Profit" and "VPIP" as two views of the same hands. They are not.
   *
   * This is the mark. A word, never an icon, and optional - a row whose scope
   * is already in its label ("Cash Hands", "Tournament Hands") stays unmarked
   * rather than saying it twice.
   *
   * It reuses `hero-stat-sub`, the stats stylesheet's existing dim micro
   * caption, on purpose: the Stats stylesheet is being rebuilt on another
   * branch, and an honest label must not wait on a paint, nor invent a class
   * that no loaded sheet defines (see tests/unit/classNamesResolve.test.ts).
   */
  scope?: string;
}) {
  return (
    <div className={`stat-row ${highlight ? 'highlight' : ''}`}>
      <span className="row-label">
        <span className="row-dot" style={{ backgroundColor: color }} />
        {label}
        {scope ? <span className="hero-stat-sub">{scope}</span> : null}
      </span>
      <span className="row-value" style={{ color }}>
        {value}
      </span>
    </div>
  );
}
