/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLES — a straight list, one table per line
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim:
 *
 *   "TABLES PAGE SHOULD BE A STRAIGHT LIST OF TABLES, TABLE 1, TABLE 2, TABLE 3
 *    ETC (IN 1X1 LINE ORDER) WITH THE AMOUNT OF PLAYERS ON IT, SMALLEST CHIP
 *    STACK, BIGGEST CHIP STACK, AND AVERAGE STACK. WHEN CLICKED IT SHOULD TAKE
 *    YOU DIRECTLY TO THAT TABLE TO OBSERVE, IT SHOULD USE THE + TABLE
 *    FUNCTIONALITY TO ADD A NEW SCREEN LEAVING THE PREVIOUS SCREEN STILL 'LIVE'
 *    (AND ONLY IF THEY HAVE THE SPACE, 4 TABLES/SCREENS MAX)."
 *
 * It replaces a three-across card grid whose cards carried the blind level (the
 * same for every table in the event, so it distinguished nothing) and no chip
 * information at all. A player scanning this tab is asking one question — which
 * table is the dangerous one — and a grid of identical cards could not answer it.
 *
 * ── WHERE THE CHIP FIGURES COME FROM ─────────────────────────────────────────
 *
 * From `entries`, grouped by `table_id`. No query, not even a batched one.
 *
 * The page loads the field from `tournament_players` selecting `chips` and
 * `table_id` (TournamentDetails.tsx, loadTournament), and keeps both live over
 * its own `tournament_players` realtime handler — an UPDATE patches chips AND
 * table_id, which is exactly what a table balance or a merge writes. Verified
 * against production before this tab was written: every one of the 114,679
 * `tournament_players` rows carries a non-null `chips`, 55,763 carry a
 * `table_id`, and grouping live rows by table gives genuinely different
 * min/avg/max per table within the same event (one running event's tables read
 * 1,515 / 17,013 / 40,958 against 9,204 / 9,204 / 9,204). The numbers are real
 * and they move.
 *
 * `table_seats` would have been the other candidate. It is the seat map, not the
 * tournament's own ledger, it needs a join per table or an `in` list, and it can
 * disagree with `tournament_players` for the seconds around a balance. Reading a
 * second source for a figure the page is already holding is how two tabs end up
 * printing two different stacks for the same player.
 *
 * ── WHY THERE IS NO SUBSCRIPTION IN THIS FILE ────────────────────────────────
 *
 * The page already subscribes to `tables` (insert/update/delete) and to the bus
 * TABLE_MERGED event, which drops the closed source table from the list. Both
 * arrive here as fresh props. A second channel would double the socket traffic
 * to render the same rows a few milliseconds earlier, and would let this tab
 * disagree with Ranking about who is seated where.
 *
 * ── THE CAP IS NOT ENFORCED HERE ─────────────────────────────────────────────
 *
 * `openTableAsObserver` ADDS a screen (the same thing the tab strip's "+" does)
 * so every table already open keeps dealing. At the screen cap MultiTablePage
 * raises the standard cap notice and declines. This tab does not pre-guess that
 * number and does not print a second message about it: one refusal, one voice.
 */

import React, { useCallback, useMemo, useEffect, useRef } from 'react';
import { warmTable, observeLobbyTableWarmups } from '../../../services/tableWarmup';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../common/Toast';
import { openTableAsObserver } from '../../../utils/observeTable';
import { chips, chipsCompact, isPlayerLive, type TournamentTabProps } from './types';
/* `TournamentEntry` was imported here too and referenced nowhere in the file. */
import type { TournamentTable } from './types';
import '../../../styles/tournament-lobby-3d.css';
import './TablesTab.css';

/* A player still in the event, and therefore still holding a stack. The rule
   lives in types.ts so this tab, Ranking, Detail and Rewards cannot count the
   field four different ways - which, until the 2026-08-26 audit, they did. */
const isLive = isPlayerLive;

/**
 * The table's number for ordering and for the row's index chip.
 *
 * Production names take three shapes: "<Event> - Table 2", "PLO4 Heads-Up 100",
 * and "<Event> - Final Table". The first two end in the number that matters; the
 * third has none, which is why the caller must have a fallback rather than
 * coercing a null into 0 and floating the final table to the top of the list.
 */
function tableNumber(name: string | null | undefined): number | null {
  const clean = (name || '').trim();
  if (!clean) return null;
  const explicit = clean.match(/table\s*#?\s*(\d+)\s*$/i);
  if (explicit) return Number(explicit[1]);
  const trailing = clean.match(/(\d+)\s*$/);
  if (trailing) return Number(trailing[1]);
  return null;
}

/** Status as written by the engine, in any case it has ever used. */
function normalisedStatus(status: string | null | undefined): string {
  return (status || '').trim().toLowerCase();
}

function isFinalTable(table: TournamentTable): boolean {
  return /final\s*table/i.test(table.name || '');
}

interface StatusLabel {
  text: string;
  /** Modifier suffix on `.tl-badge`. Empty string means the accent default. */
  tone: '' | ' tl-badge--good' | ' tl-badge--action' | ' tl-badge--danger' | ' tl-badge--mute';
}

function statusLabel(table: TournamentTable): StatusLabel {
  const status = normalisedStatus(table.status);
  if (status === 'closed') return { text: 'Closed', tone: ' tl-badge--mute' };
  if (status === 'breaking') return { text: 'Breaking', tone: ' tl-badge--danger' };
  if (isFinalTable(table)) return { text: 'Final Table', tone: ' tl-badge--action' };
  if (status === 'running') return { text: 'Running', tone: ' tl-badge--good' };
  if (status === 'waiting') return { text: 'Waiting', tone: '' };
  return { text: table.status ? table.status.replace(/_/g, ' ') : 'Unknown', tone: '' };
}

/** Everything one row needs, derived once for the whole list. */
interface TableLine {
  table: TournamentTable;
  /** Parsed table number, or the 1-based list index when the name carries none. */
  displayNumber: number;
  /** Sort key: parsed number, or a value that parks unnumbered tables last. */
  sortNumber: number;
  seated: number;
  /** True when the seat count came from the table row, so stacks are unknown. */
  seatCountIsFallback: boolean;
  minStack: number;
  avgStack: number;
  maxStack: number;
  hasStacks: boolean;
  isHeroTable: boolean;
  openable: boolean;
  /** Why the row is inert, shown on the row itself. Empty when it is not. */
  blockedReason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ONE ROW
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PRIMITIVES, NOT THE LINE OBJECT.
 *
 * `TableRow` is wrapped in `React.memo`, and passing `line` defeated it
 * completely: `lines` is rebuilt from `entries`, so EVERY chip tick produced a
 * brand-new object for every row and `memo`'s shallow compare failed on all of
 * them. A 200-table event re-rendered 200 rows and 200 meters once per chip
 * update, to change nothing on 199 of them.
 *
 * Spread flat, the shallow compare does what it is for: only a row whose own
 * numbers moved re-renders. `table` stays an object, and that is fine -- it
 * comes from the `tables` prop, whose element identities are stable across a
 * chip tick because chips arrive on `entries`.
 */
interface TableRowProps extends Omit<TableLine, 'table' | 'sortNumber'> {
  table: TournamentTable;
  /** Biggest single stack anywhere in the event: the meter's full width. */
  scaleMax: number;
  /** Average stack across the whole field, marked inside every meter. */
  fieldAvg: number;
  onOpen: (table: TournamentTable) => void;
}

const TableRow = React.memo(function TableRow({
  table,
  displayNumber,
  seated,
  seatCountIsFallback,
  minStack,
  avgStack,
  maxStack,
  hasStacks,
  isHeroTable,
  openable,
  blockedReason,
  scaleMax,
  fieldAvg,
  onOpen,
}: TableRowProps) {
  const badge = statusLabel(table);

  // The spread is drawn on ONE scale for every row, which is the whole point:
  // a table whose bar sits far right is the table to avoid being moved to.
  const spreadLeft = scaleMax > 0 ? Math.min(100, (minStack / scaleMax) * 100) : 0;
  const spreadWidth =
    scaleMax > 0
      ? Math.max(2, Math.min(100 - spreadLeft, ((maxStack - minStack) / scaleMax) * 100))
      : 0;
  const markLeft = scaleMax > 0 ? Math.min(100, (fieldAvg / scaleMax) * 100) : 0;
  const belowField = fieldAvg > 0 && avgStack > 0 && avgStack < fieldAvg;

  const seatText = `${chips(seated)}/${chips(table.max_players || 0)}`;

  const body = (
    <>
      <span className="tt-index" aria-hidden="true">
        {displayNumber}
      </span>

      <span className="tt-head">
        <span className="tt-headline">
          <span className="tl-name tt-name">{table.name || `Table ${displayNumber}`}</span>
          {isHeroTable && <span className="tl-badge tl-badge--action">Your Table</span>}
        </span>
        <span className="tt-headmeta">
          <span className={`tl-badge${badge.tone}`}>{badge.text}</span>
          <span className="tt-seats">
            <span className="tl-num tt-seatnum">{seatText}</span>
            {/* `seatCountIsFallback` was computed, stored on every line and
                documented in the interface, and then never read by anything --
                so a count taken from a possibly-stale `tables.current_players`
                row was presented exactly like a count derived from live
                entries. It is the same figure either way; the difference is
                whether it can be trusted, which is precisely the thing a
                player deciding where they are being moved needs to know. */}
            <span className="tl-sub">{seatCountIsFallback ? 'Reported' : 'Players'}</span>
          </span>
        </span>
      </span>

      {hasStacks && scaleMax > 0 && (
        <span className="tl-meter tt-meter" aria-hidden="true">
          <span
            className={`tl-meter__fill tt-spread${belowField ? ' tl-meter__fill--under' : ''}`}
            style={{ left: `${spreadLeft}%`, width: `${spreadWidth}%` }}
          />
          {fieldAvg > 0 && (
            <span
              className="tl-meter__mark"
              style={{ left: `${markLeft}%` }}
              title="Event Average"
            />
          )}
        </span>
      )}

      <span className="tt-figures">
        <span className="tt-fig">
          <span className="tl-stat__label">Smallest</span>
          <span className="tl-num tt-figvalue">{hasStacks ? chipsCompact(minStack) : '-'}</span>
        </span>
        <span className="tt-fig">
          <span className="tl-stat__label">Average</span>
          <span className="tl-num tt-figvalue tl-num--accent">
            {hasStacks ? chipsCompact(avgStack) : '-'}
          </span>
        </span>
        <span className="tt-fig">
          <span className="tl-stat__label">Biggest</span>
          <span className="tl-num tt-figvalue">{hasStacks ? chipsCompact(maxStack) : '-'}</span>
        </span>
      </span>

      {blockedReason ? (
        <span className="tl-sub tt-blocked">{blockedReason}</span>
      ) : (
        <span className="tl-sub tt-hint">Tap To Watch In A New Screen</span>
      )}
    </>
  );

  const className = [
    'tl-row',
    'tt-row',
    openable ? 'tl-row--interactive' : 'tt-row--static',
    isHeroTable ? 'tl-row--hero' : '',
    normalisedStatus(table.status) === 'closed' ? 'tl-row--eliminated' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (!openable) {
    return (
      <li className="tt-item">
        <div className={className}>{body}</div>
      </li>
    );
  }

  return (
    <li className="tt-item">
      <button
        type="button"
        className={className}
        data-warm-table={table.id}
        onPointerEnter={() => warmTable(table.id)}
        onTouchStart={() => warmTable(table.id)}
        onFocus={() => warmTable(table.id)}
        onClick={() => onOpen(table)}
        aria-label={`Watch ${table.name || `Table ${displayNumber}`}, ${seatText} Players Seated`}
      >
        {body}
      </button>
    </li>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  THE TAB
// ═══════════════════════════════════════════════════════════════════════════════

export default function TablesTab({
  tournament,
  entries,
  tables,
  currentUserId,
}: TournamentTabProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const tableListRef = useRef<HTMLUListElement>(null);

  /** Live players only. An eliminated row keeps its last table_id, and counting
   *  it would report a nine-handed table that has two players left on it. */
  const livingEntries = useMemo(() => entries.filter(isLive), [entries]);

  const heroTableId = useMemo(() => {
    if (!currentUserId) return null;
    const hero = entries.find((e) => e.user_id === currentUserId);
    /* An eliminated row keeps the `table_id` of the felt the player busted on,
       so a busted player was told "Your Table" about a table they left an hour
       ago - and on a table they can no longer be moved to (2026-08-26 audit). */
    if (!hero || !isLive(hero)) return null;
    return hero.table_id || null;
  }, [entries, currentUserId]);

  /** One pass over the field: stacks bucketed by table. */
  const byTable = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const entry of livingEntries) {
      const id = entry.table_id;
      if (!id) continue;
      const stack = Number(entry.chips);
      if (!Number.isFinite(stack)) continue;
      const bucket = map.get(id);
      if (bucket) bucket.push(stack);
      else map.set(id, [stack]);
    }
    return map;
  }, [livingEntries]);

  const fieldTotal = useMemo(
    () => livingEntries.reduce((sum, e) => sum + (Number(e.chips) || 0), 0),
    [livingEntries]
  );
  const fieldAvg = livingEntries.length > 0 ? fieldTotal / livingEntries.length : 0;

  const scaleMax = useMemo(() => {
    let top = 0;
    for (const stacks of byTable.values()) {
      for (const stack of stacks) if (stack > top) top = stack;
    }
    return top;
  }, [byTable]);

  const lines = useMemo<TableLine[]>(() => {
    const built = tables.map((table, index) => {
      const stacks = byTable.get(table.id) || [];
      const hasStacks = stacks.length > 0;

      // Seeded from the first stack rather than from 0: a player who has been
      // blinded down to nothing is a real short stack, and seeding at 0 would
      // either swallow them or, worse, report 0 as the minimum of a table where
      // nobody is actually broke.
      let minStack = hasStacks ? stacks[0] : 0;
      let maxStack = hasStacks ? stacks[0] : 0;
      let total = 0;
      for (const stack of stacks) {
        if (stack < minStack) minStack = stack;
        if (stack > maxStack) maxStack = stack;
        total += stack;
      }

      const derivedSeated = stacks.length;
      const rowSeated = Number(table.current_players) || 0;
      // The seat count on the `tables` row has historically been written late
      // (it used to stay at 0 for every tournament table). Prefer the field we
      // can see; fall back to the row only when we can see nobody at all.
      const seatCountIsFallback = derivedSeated === 0 && rowSeated > 0;

      const status = normalisedStatus(table.status);
      const closed = status === 'closed';
      const openable = !!table.id && !closed;

      const parsed = tableNumber(table.name);

      return {
        table,
        displayNumber: parsed ?? index + 1,
        sortNumber: parsed ?? Number.MAX_SAFE_INTEGER,
        seated: seatCountIsFallback ? rowSeated : derivedSeated,
        seatCountIsFallback,
        minStack,
        avgStack: hasStacks ? total / stacks.length : 0,
        maxStack,
        hasStacks,
        isHeroTable: !!heroTableId && table.id === heroTableId,
        openable,
        blockedReason: !table.id
          ? 'This Table Cannot Be Opened'
          : closed
            ? 'Closed - Players Have Moved On'
            : '',
      } as TableLine;
    });

    // Table 1, Table 2, Table 3. Unnumbered names (the Final Table) park at the
    // end, and name-then-id breaks every remaining tie so the order is stable
    // across re-renders rather than following whatever order the query returned.
    built.sort((a, b) => {
      if (a.sortNumber !== b.sortNumber) return a.sortNumber - b.sortNumber;
      const byName = (a.table.name || '').localeCompare(b.table.name || '');
      if (byName !== 0) return byName;
      return (a.table.id || '').localeCompare(b.table.id || '');
    });

    return built;
  }, [tables, byTable, heroTableId]);

  const handleOpen = useCallback(
    (table: TournamentTable) => {
      /* 2026-08-26 audit: this opened whatever row was clicked, with no closed
         check. `featuredTableId` on the details page refuses to feature a
         closed table for exactly this reason — a WATCH that lands on a dead
         felt is worse than no WATCH — but the Tables grid had no equivalent, so
         a closed row was still a live "open the felt" button. Say why instead
         of opening nothing. */
      if (String(table.status || '').toLowerCase() === 'closed') {
        toast.warning('That Table Has Closed');
        return;
      }
      const opened = openTableAsObserver(navigate, {
        tableId: table.id,
        tableName: table.name,
      });
      // Only reachable if the table row lost its id between render and click.
      if (!opened) toast.warning('That Table Is No Longer Available');
    },
    [navigate, toast]
  );

  const warmTableIds = lines
    .filter((line) => line.openable)
    .map((line) => line.table.id)
    .join(',');
  useEffect(() => {
    return observeLobbyTableWarmups(tableListRef.current ? [tableListRef.current] : []);
  }, [warmTableIds]);

  if (tables.length === 0) {
    return (
      <div className="tl-panel tt-panel">
        <div className="tl-empty">
          <span>No Tables Yet</span>
          <span className="tl-empty__hint">
            {tournament?.status === 'RUNNING'
              ? 'Seating Is Being Drawn Now'
              : 'Tables Are Created When The Event Starts'}
          </span>
        </div>
      </div>
    );
  }

  const openTables = lines.filter((l) => normalisedStatus(l.table.status) !== 'closed').length;

  return (
    <div className="tl-panel tt-panel">
      <div className="tl-stat-grid tt-stats">
        <div className="tl-stat">
          <span className="tl-stat__label">Tables</span>
          <span className="tl-stat__value tl-stat__value--accent">{chips(openTables)}</span>
          <span className="tl-stat__sub">Of {chips(lines.length)}</span>
        </div>
        <div className="tl-stat">
          <span className="tl-stat__label">Players Left</span>
          <span className="tl-stat__value">{chips(livingEntries.length)}</span>
          <span className="tl-stat__sub">Still In</span>
        </div>
        <div className="tl-stat">
          <span className="tl-stat__label">Average Stack</span>
          <span className="tl-stat__value">{chipsCompact(fieldAvg)}</span>
          <span className="tl-stat__sub">Across The Field</span>
        </div>
      </div>

      <div className="tl-section-head tt-head-bar">
        <h3>Tables</h3>
        {/* Balancing only means anything while there is more than one table to
            balance against, so a heads-up final does not advertise it. */}
        {openTables > 1 && <span className="tl-badge tl-badge--good">Auto-Balancing Enabled</span>}
      </div>

      <ul ref={tableListRef} className="tl-list tl-scroll tt-list">
        {lines.map((line, i) => (
          <TableRow
            {...line}
            /* The id, but falling back to the index. This file explicitly
               handles a table with no id ("This Table Cannot Be Opened"), so
               an id-less row is a known case -- and TWO of them produced two
               siblings keyed `undefined`, which React warns about and which
               lets it reuse the wrong DOM node between renders. */
            key={line.table.id || `row-${i}`}
            scaleMax={scaleMax}
            fieldAvg={fieldAvg}
            onOpen={handleOpen}
          />
        ))}
      </ul>

      <p className="tt-note">
        Bar Shows Smallest To Biggest Stack Per Table. The Marker Is The Event Average
      </p>
    </div>
  );
}
