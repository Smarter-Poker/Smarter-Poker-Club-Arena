/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIVE TABLES BAR — global "you have games running" dock
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-19 (persistence upgrade): originally this bar lived on the club
 * lobby only and re-queried table_seats itself, because MultiTablePage
 * unmounted on every navigation. The container is now mounted persistently
 * beside <Routes> (see PersistentTableLayer), so the mounted tabs ARE the
 * truth — this component became a pure presentational dock that
 * MultiTablePage renders on EVERY non-/table route while tables are live.
 *
 * Two states:
 * - quiet:  "Return to game →" — tables running, nobody waiting on the hero.
 * - urgent: "Action needed — <table> · Ns" — a hidden table's action clock is
 *   running on the hero; tapping it focuses that tab and returns to /table/*.
 *
 * Read-only: it never mutates seats, it only asks the container to navigate.
 */

import { formatGameTitle } from '../../utils/formatGameTitle';
import './LiveTablesBar.css';

export interface LiveTablesBarProps {
  /** Table-kind tabs currently mounted, in tab order (lobby tabs excluded). */
  tables: { id: string; name: string }[];
  /** The mounted table whose action clock is running on the hero, if any. */
  urgent: { tableId: string; name: string; secondsLeft?: number } | null;
  /** Focus the tab and navigate back onto /table/:id. */
  onReturn: (tableId: string) => void;
}

export default function LiveTablesBar({ tables, urgent, onReturn }: LiveTablesBarProps) {
  if (tables.length === 0) return null;

  if (urgent) {
    return (
      <button
        className="live-tables-bar live-tables-bar--urgent"
        onClick={() => onReturn(urgent.tableId)}
        title="Your Turn - Return To The Table"
        /* Audit 2026-08-25: this dock is the ONLY signal a player browsing the
           cashier gets that a hand is about to be folded out from under them,
           and it appeared with no announcement at all. `assertive`, because by
           definition there are seconds left; the label carries the table name
           so the announcement is actionable rather than "action needed". */
        aria-live="assertive"
        aria-atomic="true"
      >
        <span className="live-tables-bar__dot live-tables-bar__dot--urgent" aria-hidden="true">
          ●
        </span>
        <span className="live-tables-bar__label">
          Action Needed - {formatGameTitle(urgent.name)}
        </span>
        {urgent.secondsLeft !== undefined && (
          <span className="live-tables-bar__timer">{urgent.secondsLeft}s</span>
        )}
        <span className="live-tables-bar__cta">Act Now →</span>
      </button>
    );
  }

  /* Dan 2026-08-20: the variant is an acronym and must read as one — the dock
     was showing "nlh 0.1/0.2" because that name was assembled from the
     lowercase game_variant enum. formatGameTitle fixes it for every producer,
     including club owners who type the name by hand. */
  const label =
    tables.length === 1 ? formatGameTitle(tables[0].name) : `${tables.length} Live Tables`;

  return (
    <button
      className="live-tables-bar"
      onClick={() => onReturn(tables[0].id)}
      title="Return To Your Live Tables"
    >
      <span className="live-tables-bar__dot" aria-hidden="true">
        ●
      </span>
      <span className="live-tables-bar__label">{label}</span>
      <span className="live-tables-bar__cta">Return To Game →</span>
    </button>
  );
}
