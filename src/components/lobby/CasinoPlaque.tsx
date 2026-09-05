/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CASINO PLAQUE — the premium hero of the selected game lobby (Lobby V2)
 * ═══════════════════════════════════════════════════════════════════════════════
 * A horizontal three-zone plaque styled like a high-end physical casino table
 * marker: brushed black metal, gunmetal insets, satin silver trim, restrained
 * gold. Purely presentational — every value comes from the REAL game
 * configuration via LobbyEntry; a rule medallion renders only when the game
 * data says the rule is active.
 *
 *   LEFT    game identity (type, stakes or tournament name)
 *   CENTER  active rule medallions (physical chip look)
 *   RIGHT   joining information (buy-in, seats, primary CTA — passed in)
 */

import type { LobbyEntry } from './lobbyEntries';
import './CasinoPlaque.css';

interface CasinoPlaqueProps {
  entry: LobbyEntry;
  /** Right-zone content: buy-in figures, seat meter, primary CTA. */
  children?: React.ReactNode;
}

export default function CasinoPlaque({ entry, children }: CasinoPlaqueProps) {
  const isCash = entry.kind === 'cash';
  const kindLabel =
    entry.kind === 'cash'
      ? null
      : entry.kind === 'mtt'
        ? 'TOURNAMENT'
        : entry.kind === 'spin'
          ? 'SPIN'
          : 'HEADS UP';

  return (
    <section className="cplaque" aria-label={`${entry.name} Game Details`}>
      <div className="cplaque__screws" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>

      {/* ── LEFT: game identity ── */}
      <div className="cplaque__identity">
        {kindLabel && <div className="cplaque__kind">{kindLabel}</div>}
        <div className="cplaque__game">{isCash ? entry.gameLabel : entry.name}</div>
        <div className="cplaque__sub">
          {isCash ? (
            <>
              <span className="cplaque__variant">{entry.variantLabel}</span>
              {/* `stakesLabel: string | null` — null means the row cannot say
                  its stakes, and the contract is that it then says NOTHING.
                  The dangling word "Blinds" over nothing broke that (ITEM E
                  audit, 2026-08-26); COL_STAKES on the board already drops
                  the cell. */}
              {entry.stakesLabel && (
                <span className="cplaque__stakes">Blinds {entry.stakesLabel}</span>
              )}
            </>
          ) : (
            <span className="cplaque__variant">
              {entry.variantLabel}
              {entry.speedLabel && entry.speedLabel !== 'Standard' ? ` · ${entry.speedLabel}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* ── CENTER: rule medallions (active rules only) ── */}
      <div className="cplaque__rules" role="list" aria-label="Table Rules">
        {entry.rules.length === 0 ? (
          <span className="cplaque__norules">Standard Rules</span>
        ) : (
          entry.rules.map((rule) => (
            <div key={rule.key} className="cplaque__medallion" role="listitem" title={rule.tip}>
              <span className="cplaque__medallion-ring" aria-hidden="true" />
              <span className="cplaque__medallion-label">{rule.label}</span>
              {rule.detail && <span className="cplaque__medallion-detail">{rule.detail}</span>}
            </div>
          ))
        )}
      </div>

      {/* ── RIGHT: joining information ── */}
      <div className="cplaque__join">{children}</div>
    </section>
  );
}

/** Seat pips used in the plaque's right zone.
 *
 * `bareCount` is the MTT form (ITEM E audit, 2026-08-26): the canonical rule
 * — seatsTakenLabel, pinned to Dan 2026-08-24, "THERE ARE NO LIMITATIONS ON
 * THE AMOUNT OF PLAYERS THAT CAN REGISTER, IT SHOULDN'T DEFAULT TO /500" —
 * prints a bare entry count for an MTT. This component was the last surface
 * still rendering `45 / 500 Seats` with pips against a cap that is not a cap. */
export function PlaqueSeats({
  players,
  capacity,
  bareCount = false,
  tables,
}: {
  players: number;
  capacity: number;
  bareCount?: boolean;
  /** A must-move GAME (R10): the count is running, across this many tables. */
  tables?: number;
}) {
  if (tables != null) {
    /* Dan 2026-09-05: "THEY SHOULD NEVER BE 2/6 OR 9/9 THEY ARE RUNNING
       COUNTS NOW." A game has no ceiling a single table would have - a full
       Main opens a feeder - so it prints players and tables, no pips. */
    return (
      <div
        className="cplaque__seats cplaque__seats--game"
        aria-label={`${players} Playing Across ${tables} ${tables === 1 ? 'Table' : 'Tables'}`}
      >
        <span className="cplaque__seats-num">
          {players.toLocaleString()} Playing {'\u00b7'} {tables} {tables === 1 ? 'Table' : 'Tables'}
        </span>
      </div>
    );
  }
  if (bareCount) {
    return (
      <div className="cplaque__seats" aria-label={`${players} Entered`}>
        <span className="cplaque__seats-num">{players.toLocaleString()} Entered</span>
      </div>
    );
  }
  const cap = Math.max(0, Math.min(capacity || 0, 12));
  return (
    /* The visible text prints "-" for an unknown capacity; the label used to
       interpolate the raw 0 and announce "12 of 0 seats filled". */
    <div
      className="cplaque__seats"
      aria-label={
        capacity > 0
          ? `${players} Of ${capacity} Seats Filled`
          : `${players} Seated, Capacity Unknown`
      }
    >
      <span className="cplaque__seats-num">
        {players} / {capacity || '-'} Seats
      </span>
      {cap > 0 && (
        <span className="cplaque__seats-pips" aria-hidden="true">
          {Array.from({ length: cap }).map((_, i) => (
            <i key={i} className={i < players ? 'is-filled' : ''} />
          ))}
        </span>
      )}
    </div>
  );
}
