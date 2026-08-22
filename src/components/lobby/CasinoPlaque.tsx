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
    <section className="cplaque" aria-label={`${entry.name} game details`}>
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
              <span className="cplaque__stakes">Blinds {entry.stakesLabel}</span>
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
      <div className="cplaque__rules" role="list" aria-label="Table rules">
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

/** Seat pips used in the plaque's right zone. */
export function PlaqueSeats({ players, capacity }: { players: number; capacity: number }) {
  const cap = Math.max(0, Math.min(capacity || 0, 12));
  return (
    <div className="cplaque__seats" aria-label={`${players} of ${capacity} seats filled`}>
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
