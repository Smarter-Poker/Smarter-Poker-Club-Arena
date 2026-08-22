/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOBBY TABLE — dense, line-based game browser (Club Arena Lobby V2)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Replaces the large card grid with a professional desktop-poker-client table:
 * sticky headers, compact sortable rows, per-category columns, keyboard
 * navigation, and explicit row states. Selecting a row NEVER joins or spends —
 * it opens the game lobby panel where the player commits explicitly.
 *
 * Sorting always uses the underlying numeric values on LobbyEntry
 * (stakesValue / buyInValue / startValue), never the formatted strings.
 */

import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import type { LobbyEntry, LobbyStatusKey } from './lobbyEntries';
import './LobbyTable.css';

export type LobbyCategory = 'ALL' | 'HOLDEM' | 'OMAHA' | 'LIMIT' | 'MIXED' | 'MTT' | 'SNG' | 'SPIN';

export interface LobbyRowContext {
  waitlistedIds: Set<string>;
  seatedIds: Set<string>;
  registeredIds: Set<string>;
  favoriteIds: Set<string>;
  onToggleFavorite?: (tableId: string, next: boolean) => void;
}

interface ColumnDef {
  key: string;
  label: string;
  className?: string;
  sortable?: boolean;
  sortValue?: (e: LobbyEntry) => number | string;
  render: (e: LobbyEntry, ctx: LobbyRowContext) => React.ReactNode;
}

// ─── Cell renderers ────────────────────────────────────────────────────────
const RULE_ABBR: Record<string, string> = {
  rit: 'RIT',
  insurance: 'INS',
  straddle: 'STR',
  bomb: 'BOMB',
  ante: 'ANTE',
  double_board: '2BRD',
  seven_deuce: '72',
  time_bank: 'TB',
  vpip: 'VPIP',
  call_time: 'CT',
  no_rathole: 'NR',
};

function RulesCell({ entry }: { entry: LobbyEntry }) {
  const shown = entry.rules.slice(0, 4);
  const extra = entry.rules.length - shown.length;
  if (shown.length === 0) return <span className="lt-dim">-</span>;
  return (
    <span className="lt-rules">
      {shown.map((r) => (
        <abbr key={r.key} title={r.tip} className="lt-rule">
          {RULE_ABBR[r.key] || r.label.slice(0, 4)}
        </abbr>
      ))}
      {extra > 0 && <span className="lt-rule lt-rule--more">+{extra}</span>}
    </span>
  );
}

export function LobbyStatusBadge({ status, label }: { status: LobbyStatusKey; label: string }) {
  return <span className={`lt-status lt-status--${status}`}>{label}</span>;
}

function PlayerStateChip({ entry, ctx }: { entry: LobbyEntry; ctx: LobbyRowContext }) {
  if (entry.kind === 'cash') {
    if (ctx.seatedIds.has(entry.id)) return <span className="lt-mine">Seated</span>;
    if (ctx.waitlistedIds.has(entry.id))
      return <span className="lt-mine lt-mine--wait">Waitlisted</span>;
    return null;
  }
  if (ctx.registeredIds.has(entry.id)) return <span className="lt-mine">Registered</span>;
  return null;
}

function StartsCell({ entry }: { entry: LobbyEntry }) {
  if (!entry.startTime) return <span className="lt-dim">When Full</span>;
  const d = new Date(entry.startTime);
  if (!Number.isFinite(d.getTime())) return <span className="lt-dim">-</span>;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return <span>{time}</span>;
  return (
    <span>
      {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} {time}
    </span>
  );
}

function SeatsMeter({ entry }: { entry: LobbyEntry }) {
  const pct =
    entry.capacity > 0 ? Math.min(100, Math.round((entry.players / entry.capacity) * 100)) : 0;
  const full = entry.capacity > 0 && entry.players >= entry.capacity;
  return (
    <span className={`lt-seats${full ? ' lt-seats--full' : ''}`}>
      <span className="lt-seats__num">
        {entry.players}/{entry.capacity || '-'}
      </span>
      <span className="lt-seats__bar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function FavCell({ entry, ctx }: { entry: LobbyEntry; ctx: LobbyRowContext }) {
  if (entry.kind !== 'cash' || !ctx.onToggleFavorite) return <span className="lt-dim" />;
  const isFav = ctx.favoriteIds.has(entry.id);
  return (
    <button
      type="button"
      className={`lt-fav${isFav ? ' is-on' : ''}`}
      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={isFav}
      title={isFav ? 'Remove From Favorites' : 'Add To Favorites'}
      onClick={(e) => {
        e.stopPropagation();
        ctx.onToggleFavorite?.(entry.id, !isFav);
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9L12 2.6z"
          fill={isFav ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    </button>
  );
}

// ─── Column sets per category ──────────────────────────────────────────────
const COL_FAV: ColumnDef = {
  key: 'fav',
  label: '',
  className: 'lt-col-fav',
  render: (e, ctx) => <FavCell entry={e} ctx={ctx} />,
};
const COL_NAME: ColumnDef = {
  key: 'name',
  label: 'Game',
  className: 'lt-col-name',
  sortable: true,
  sortValue: (e) => (e.name || '').toLowerCase(),
  render: (e) => (
    <span className="lt-name" title={e.name}>
      {e.live && <i className="lt-live" aria-hidden="true" title="Live" />}
      {e.name}
    </span>
  ),
};
const COL_TNAME: ColumnDef = { ...COL_NAME, label: 'Tournament' };
const COL_STAKES: ColumnDef = {
  key: 'stakes',
  label: 'Stakes',
  className: 'lt-col-num',
  sortable: true,
  sortValue: (e) => e.stakesValue,
  render: (e) => <span className="lt-mono">{e.stakesLabel || '-'}</span>,
};
const COL_VARIANT: ColumnDef = {
  key: 'variant',
  label: 'Variant',
  className: 'lt-col-variant',
  sortable: true,
  sortValue: (e) => e.gameLabel,
  render: (e) => (
    <abbr className="lt-variant" title={e.variantLabel}>
      {e.gameLabel}
    </abbr>
  ),
};
const COL_PLAYERS: ColumnDef = {
  key: 'players',
  label: 'Players',
  className: 'lt-col-players',
  sortable: true,
  sortValue: (e) => e.players,
  render: (e) => <SeatsMeter entry={e} />,
};
const COL_BUYIN: ColumnDef = {
  key: 'buyin',
  label: 'Buy-In',
  className: 'lt-col-num',
  sortable: true,
  sortValue: (e) => e.buyInValue,
  render: (e) => <span className="lt-mono">{e.buyInLabel}</span>,
};
const COL_GTD: ColumnDef = {
  key: 'gtd',
  label: 'Guarantee',
  className: 'lt-col-num',
  sortable: true,
  sortValue: (e) => e.guaranteeValue,
  render: (e) =>
    e.guaranteeLabel ? (
      <span className="lt-mono lt-gtd">{e.guaranteeLabel}</span>
    ) : (
      <span className="lt-dim">-</span>
    ),
};
const COL_RULES: ColumnDef = {
  key: 'rules',
  label: 'Rules',
  className: 'lt-col-rules',
  render: (e) => <RulesCell entry={e} />,
};
const COL_STARTS: ColumnDef = {
  key: 'starts',
  label: 'Starts',
  className: 'lt-col-starts',
  sortable: true,
  sortValue: (e) => e.startValue,
  render: (e) => <StartsCell entry={e} />,
};
const COL_SPEED: ColumnDef = {
  key: 'speed',
  label: 'Speed',
  className: 'lt-col-speed',
  sortable: true,
  sortValue: (e) => e.speedLabel || '',
  render: (e) => (e.speedLabel ? <span>{e.speedLabel}</span> : <span className="lt-dim">-</span>),
};
const COL_STATUS: ColumnDef = {
  key: 'status',
  label: 'Status',
  className: 'lt-col-status',
  sortable: true,
  sortValue: (e) => e.status,
  render: (e, ctx) => (
    <span className="lt-statuscell">
      <LobbyStatusBadge status={e.status} label={e.statusLabel} />
      <PlayerStateChip entry={e} ctx={ctx} />
    </span>
  ),
};
const COL_KIND: ColumnDef = {
  key: 'kind',
  label: 'Type',
  className: 'lt-col-kind',
  sortable: true,
  sortValue: (e) => e.kind,
  render: (e) => (
    <span className="lt-kind">
      {e.kind === 'cash'
        ? 'Cash'
        : e.kind === 'mtt'
          ? 'MTT'
          : e.kind === 'spin'
            ? 'Spin'
            : 'Heads Up'}
    </span>
  ),
};
const COL_COST: ColumnDef = {
  key: 'cost',
  label: 'Stakes / Buy-In',
  className: 'lt-col-num',
  sortable: true,
  sortValue: (e) => (e.kind === 'cash' ? e.stakesValue : e.buyInValue),
  render: (e) => (
    <span className="lt-mono">{e.kind === 'cash' ? e.stakesLabel : e.buyInLabel}</span>
  ),
};

export function columnsFor(category: LobbyCategory): ColumnDef[] {
  switch (category) {
    case 'HOLDEM':
    case 'OMAHA':
    case 'LIMIT':
    case 'MIXED':
      return [
        COL_FAV,
        COL_NAME,
        COL_STAKES,
        COL_VARIANT,
        COL_PLAYERS,
        COL_BUYIN,
        COL_RULES,
        COL_STATUS,
      ];
    case 'MTT':
      return [
        COL_TNAME,
        COL_VARIANT,
        COL_BUYIN,
        COL_GTD,
        COL_PLAYERS,
        COL_STARTS,
        COL_SPEED,
        COL_STATUS,
      ];
    case 'SPIN':
      return [COL_NAME, COL_VARIANT, COL_BUYIN, COL_PLAYERS, COL_SPEED, COL_STATUS];
    case 'SNG':
      return [COL_NAME, COL_VARIANT, COL_BUYIN, COL_PLAYERS, COL_STATUS];
    case 'ALL':
    default:
      return [
        COL_FAV,
        COL_NAME,
        COL_KIND,
        COL_VARIANT,
        COL_COST,
        COL_PLAYERS,
        COL_STARTS,
        COL_RULES,
        COL_STATUS,
      ];
  }
}

// ─── The table ─────────────────────────────────────────────────────────────
interface LobbyTableProps {
  entries: LobbyEntry[];
  category: LobbyCategory;
  selectedId: string | null;
  onSelect: (entry: LobbyEntry) => void;
  /** Enter key / double click — open the game lobby (same as select; never joins). */
  onActivate: (entry: LobbyEntry) => void;
  ctx: LobbyRowContext;
  loading?: boolean;
}

type SortDir = 'asc' | 'desc';

export default function LobbyTable({
  entries,
  category,
  selectedId,
  onSelect,
  onActivate,
  ctx,
  loading,
}: LobbyTableProps) {
  const columns = useMemo(() => columnsFor(category), [category]);
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // Column sort resets when the category (and therefore the columns) change.
  useEffect(() => setSort(null), [category]);

  const sorted = useMemo(() => {
    if (!sort) return entries;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return entries;
    const sv = col.sortValue;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...entries].sort((a, b) => {
      const va = sv(a);
      const vb = sv(b);
      if (typeof va === 'number' && typeof vb === 'number') {
        const na = Number.isFinite(va) ? va : Infinity;
        const nb = Number.isFinite(vb) ? vb : Infinity;
        return (na - nb) * dir;
      }
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [entries, sort, columns]);

  const handleHeaderClick = (col: ColumnDef) => {
    if (!col.sortable) return;
    setSort((prev) => {
      if (!prev || prev.key !== col.key) return { key: col.key, dir: 'asc' };
      if (prev.dir === 'asc') return { key: col.key, dir: 'desc' };
      return null; // third click clears back to the page-level order
    });
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      if (sorted.length === 0) return;
      const idx = sorted.findIndex((r) => r.id === selectedId);
      if (e.key === 'Enter') {
        if (idx >= 0) {
          e.preventDefault();
          onActivate(sorted[idx]);
        }
        return;
      }
      e.preventDefault();
      const next =
        e.key === 'ArrowDown'
          ? Math.min(sorted.length - 1, idx + 1)
          : Math.max(0, idx < 0 ? 0 : idx - 1);
      onSelect(sorted[next]);
      // Keep the focused row in view inside the sticky-header scroller.
      const rowEl = bodyRef.current?.querySelector<HTMLTableRowElement>(
        `tr[data-id="${sorted[next].id}"]`
      );
      rowEl?.scrollIntoView({ block: 'nearest' });
    },
    [sorted, selectedId, onSelect, onActivate]
  );

  return (
    <div
      className="lobby-table-wrap"
      role="region"
      aria-label="Game list"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <table className="lobby-table">
        <thead>
          <tr>
            {columns.map((col) => {
              const active = sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  className={`${col.className || ''}${col.sortable ? ' is-sortable' : ''}${active ? ' is-sorted' : ''}`}
                  aria-sort={
                    active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  onClick={() => handleHeaderClick(col)}
                >
                  <span className="lt-th">
                    {col.label}
                    {col.sortable && (
                      <span className="lt-sortmark" aria-hidden="true">
                        {active ? (sort!.dir === 'asc' ? '▴' : '▾') : '▴▾'}
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {loading &&
            entries.length === 0 &&
            Array.from({ length: 8 }).map((_, i) => (
              <tr key={`skel-${i}`} className="lt-row lt-row--skeleton" aria-hidden="true">
                {columns.map((c) => (
                  <td key={c.key} className={c.className}>
                    <span className="lt-skel" />
                  </td>
                ))}
              </tr>
            ))}
          {sorted.map((entry) => {
            const selected = entry.id === selectedId;
            return (
              <tr
                key={entry.id}
                data-id={entry.id}
                className={`lt-row lt-row--${entry.status}${selected ? ' is-selected' : ''}`}
                aria-selected={selected}
                onClick={() => onSelect(entry)}
                onDoubleClick={() => onActivate(entry)}
              >
                {columns.map((col) => (
                  <td key={col.key} className={col.className}>
                    {col.render(entry, ctx)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
