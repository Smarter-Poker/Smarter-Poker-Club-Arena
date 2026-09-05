/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND DETAIL VIEW — the one rundown, rendered once
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-27: "make sure the HAND DETAILS looks and is exactly like it
 * appears inside our hand details. don't leave anything out. and make sure that
 * smarter.poker looks and feels like this with all the same data points and
 * architecture."
 *
 * Both hand-detail surfaces — the jackpot rundown and the table's Previous Hand
 * — render THIS, off the model `buildReplay()` produces. They had drifted into
 * two layouts with two different reconstructions and two different bugs; the
 * point of one component is that they cannot drift again.
 *
 * THE GRAMMAR, top to bottom:
 *
 *   date · stakes · SN
 *   per street:  name · the board face-up so far · the pot after the street
 *                one row per action: position, player, what they did, how much,
 *                                    and THE STACK THEY HAVE LEFT
 *                a fold shows face-down cards; a showdown reveal shows the real
 *                ones; an uncalled bet shows as a negative `return`
 *                Pot        Main(x)
 *   Showdown:    every player dealt in — cards or backs, the made hand, the
 *                five that played lit, the net, the pot they contested
 *   the drop:    rake and jackpot fee, taken from the pot
 *
 * THE STACK COLUMN IS CONDITIONAL, and that is deliberate. It is reconstructed
 * (nothing stores a starting stack), and the reconstruction is only sound when
 * the rebuilt pot lands on the engine's own `pot_size`. Measured over the 4,000
 * most recent live hands it does on 99.18%; the 0.8% that miss are tournament
 * hands with antes and cash hands with a straddle, neither of which is written
 * anywhere in the row. On those the column is withdrawn rather than drawn
 * wrong — the same rule the running-pot column already followed.
 */

import CardImage, { CardBack } from '../table/CardImage';
import { cardKey } from '../../utils/handEvaluator';
import type { ReplayModel, ReplayRow, ReplayShowdownRow } from '../../utils/handReplay';
import './HandDetailView.css';
import { blindLabel, money, stamp } from '../../utils/handFormat';

export interface HandDetailViewProps {
  model: ReplayModel;
  /** Highlights the viewer's own rows. */
  currentUserId?: string | null;
  currentUserName?: string | null;
  /** Rendered under the showdown — the BBJP Winners box on a jackpot hand. */
  footer?: React.ReactNode;
  /** Extra chip beside the stakes, e.g. the game type. */
  badge?: string | null;
  /**
   * The player whose hand the jackpot was paid for, if this hand hit one.
   * The showdown marks them. `.hdv__sd.is-badbeat` and `.hdv__sd-tag` existed
   * for this from the start and had no writer.
   */
  badBeatUserId?: string | null;
}

/** How many face-down cards a muck shows — the variant's own holding size. */
function muckWidth(variant: string | null, players: ReplayModel['players']): number {
  const shown = players.find((p) => p.hole && p.hole.length > 0)?.hole?.length;
  if (shown) return shown;
  const v = String(variant || '').toLowerCase();
  if (v.startsWith('plo6')) return 6;
  if (v.startsWith('plo5') || v.includes('bigo') || v.includes('big_o')) return 5;
  if (v.startsWith('plo') || v.startsWith('flo')) return 4;
  if (v.includes('pineapple')) return 3;
  return 2;
}

function ActionRow({
  row,
  isYou,
  showStack,
  muckCount,
}: {
  row: ReplayRow;
  isYou: boolean;
  showStack: boolean;
  muckCount: number;
}) {
  return (
    <div className="hdv__row">
      <span className="hdv__pos">{row.position}</span>
      <span className={`hdv__name${isYou ? ' is-you' : ''}`}>{row.name}</span>
      <span className={`hdv__act hdv__act--${row.verb}`}>{row.label}</span>

      <span className="hdv__cards">
        {/* YOUR OWN FOLD SHOWS YOUR OWN CARDS (2026-09-04). The record's
            hole_cards column is showdown-only, so a fold drew backs even for
            the viewer's own hand. `privateCards` is filled from the viewer's
            own ca_hand_facts row - RLS returns nobody else's - so this is
            face-up for you and backs for everyone else, marked as private so
            a face-up fold is never read as a reveal. */}
        {row.showsMuck && row.privateCards && row.privateCards.length > 0 ? (
          <>
            {row.privateCards.map((c, i) => (
              <CardImage key={`p-${row.key}-${i}`} card={c} size="xs" className="hdv-private" />
            ))}
            <span className="hdv__private-tag">Yours</span>
          </>
        ) : (
          row.showsMuck &&
          Array.from({ length: muckCount }).map((_, i) => (
            <CardBack key={`m-${row.key}-${i}`} size="xs" />
          ))
        )}
        {row.shownCards?.map((c, i) => (
          <CardImage key={`s-${row.key}-${i}`} card={c} size="xs" />
        ))}
        {/* PHASE 4 2026-09-01: the card you threw, on your own discard row.
            Only ever present for the viewer - `hand_discards` is read through
            an RLS policy that returns nothing but the caller's own rows, so
            this cannot draw an opponent's discard even if the model asked it
            to. Drawn face UP because it is yours and you already chose it. */}
        {row.discardedCard && <CardImage key={`d-${row.key}`} card={row.discardedCard} size="xs" />}
      </span>

      <span className={`hdv__amt${row.amount < 0 ? ' is-return' : ''}`}>
        {row.amount === 0 ? '' : money(row.amount)}
      </span>
      <span className="hdv__stack">
        {showStack && row.stackAfter !== null ? money(row.stackAfter) : ''}
      </span>
    </div>
  );
}

function ShowdownRow({
  row,
  isYou,
  muckCount,
  isBadBeat,
}: {
  row: ReplayShowdownRow;
  isYou: boolean;
  muckCount: number;
  /** The hand the jackpot was paid for. It is the story; mark it. */
  isBadBeat: boolean;
}) {
  const net = row.net;
  return (
    <div
      className={`hdv__sd${row.isWinner ? ' is-winner' : ''}${isBadBeat ? ' is-badbeat' : ''}${
        row.low ? ' is-low' : ''
      }`}
    >
      <div className="hdv__sd-who">
        <span className={`hdv__name${isYou ? ' is-you' : ''}`}>
          {row.name}
          {isBadBeat && <span className="hdv__sd-tag">BAD BEAT</span>}
          {/* HI-LO: the half this row is for. A PLO8 scoop is two rows. */}
          {row.low && <span className="hdv__sd-tag hdv__sd-tag--low">LOW</span>}
          {/* Your own mucked cards, drawn face-up for you alone. */}
          {row.holePrivate && <span className="hdv__private-tag">Yours, Not Shown</span>}
        </span>
        <span className="hdv__sd-holerow">
          <span className="hdv__pos">{row.position}</span>
          <span className="hdv__cards">
            {row.hole
              ? row.hole.map((c, i) => (
                  <CardImage
                    key={`h-${row.key}-${i}`}
                    card={c}
                    size="xs"
                    /* cardKey(), not a template literal. The model builds the
                       set with cardKey (which uppercases the rank), and the
                       two agreed only by accident of upstream normalisation —
                       the day a card arrives un-normalised the "which five
                       played" highlight fails silently. */
                    className={`${row.playing.includes(cardKey(c)) ? 'hdv-plays' : 'hdv-idle'}${row.holePrivate ? ' hdv-private' : ''}`}
                  />
                ))
              : Array.from({ length: muckCount }).map((_, i) => (
                  <CardBack key={`hb-${row.key}-${i}`} size="xs" />
                ))}
          </span>
        </span>
      </div>

      <div className="hdv__sd-made">
        <span className="hdv__sd-handname">{row.handName}</span>
        <span className="hdv__cards">
          {row.made.map((c, i) => (
            <CardImage key={`m-${row.key}-${i}`} card={c} size="xs" />
          ))}
        </span>
      </div>

      <div className="hdv__sd-right">
        <span
          className={`hdv__sd-net${net === null ? ' is-blank' : net >= 0 ? ' is-up' : ' is-down'}`}
        >
          {net === null ? '' : `${net >= 0 ? '+' : '-'}${money(Math.abs(net))}`}
        </span>
        <span className="hdv__sd-pot">{row.boardLabel || row.potLabel}</span>
      </div>
    </div>
  );
}

export function HandDetailView({
  model,
  currentUserId,
  currentUserName,
  footer,
  badge,
  badBeatUserId,
}: HandDetailViewProps) {
  // Id first: two players can share a display name, and lighting the wrong row
  // on a money surface is not a cosmetic mistake.
  const isYou = (userId: string, name: string) => {
    if (currentUserId && userId) return userId === currentUserId;
    return !!currentUserName && name.toLowerCase() === currentUserName.toLowerCase();
  };

  const muckCount = muckWidth(model.gameVariant, model.players);
  const showStack = model.reconciles;

  return (
    <div className={`hdv${showStack ? '' : ' is-nostack'}`}>
      <div className="hdv__meta">
        <span className="hdv__meta-when">{stamp(model.playedAt)}</span>
        <span className="hdv__meta-stakes">
          {blindLabel(model.smallBlind)} / {blindLabel(model.bigBlind)}
          {badge ? <em className="hdv__meta-badge">{badge}</em> : null}
        </span>
        <span className="hdv__meta-sn">SN: {model.handNumber ?? ''}</span>
      </div>

      {/* Six cells over a six-track grid, so each word sits above the column it
          names. It used to be three cells over a six-track row. */}
      <div className="hdv__colkey">
        <span />
        <span>Player</span>
        <span>Action</span>
        <span />
        <span>Amount</span>
        <span>{showStack ? 'Stack' : ''}</span>
      </div>

      {model.streets.map((street) => (
        <section className="hdv__street" key={street.key}>
          <header className="hdv__street-head">
            <span className="hdv__street-name">{street.label}</span>
            <span className="hdv__street-board">
              {street.board.map((c, i) => (
                <CardImage key={`b-${street.key}-${i}`} card={c} size="xs" />
              ))}
            </span>
            <span className="hdv__street-pot">{money(street.potAfter)}</span>
          </header>

          {/* RUN IT TWICE / DOUBLE BOARD. The model has carried these boards
              since the RPC started returning them, and the view drew only
              board one — the second run existed as a text label and nothing
              else. One row per extra board, same street, labelled. */}
          {street.extraBoards.map((b, bi) =>
            b.length > 0 ? (
              <div className="hdv__street-run" key={`run-${street.key}-${bi}`}>
                <span className="hdv__street-run-label">Run {bi + 2}</span>
                <span className="hdv__street-board">
                  {b.map((c, i) => (
                    <CardImage key={`b2-${street.key}-${bi}-${i}`} card={c} size="xs" />
                  ))}
                </span>
              </div>
            ) : null
          )}

          {street.rows.map((row) => (
            <ActionRow
              key={row.key}
              row={row}
              isYou={isYou(row.userId, row.name)}
              showStack={showStack}
              muckCount={muckCount}
            />
          ))}

          {/* THE POT LINE IS A RUNNING TOTAL until the last street.
              It printed `Main(x)` after every street, so a flop section claimed
              to be the main pot on a hand whose main pot was ten times larger.
              Only the final street speaks for the pot, and only there is the
              real main/side breakdown shown. */}
          <div className="hdv__potline">
            <span>Pot</span>
            {street.isFinal ? (
              <span>
                {/* Keyed by index, not by label: two Side pots without an
                    index suffix share a label, and a duplicate React key drops
                    one of them from the line that states the pot breakdown. */}
                {model.pots.map((p, i) => (
                  <span key={`${i}-${p.label}`}>
                    {i > 0 ? '  ' : ''}
                    {p.label}({money(p.amount)})
                  </span>
                ))}
              </span>
            ) : (
              <span>{money(street.potAfter)}</span>
            )}
          </div>
        </section>
      ))}

      {(model.rake > 0 || model.bbjFee > 0) && (
        <div className="hdv__drop">
          {model.rake > 0 && (
            <span>
              Rake <strong>{money(model.rake)}</strong>
            </span>
          )}
          {model.bbjFee > 0 && (
            <span>
              Jackpot Fee <strong>{money(model.bbjFee)}</strong>
            </span>
          )}
          <span className="hdv__drop-note">Taken From The Pot</span>
        </div>
      )}

      {model.showdown.length > 0 && (
        <section className="hdv__showdown">
          <header className="hdv__section-head">Showdown</header>
          {model.showdown.map((row) => (
            <ShowdownRow
              key={row.key}
              row={row}
              isYou={isYou(row.userId, row.name)}
              muckCount={muckCount}
              isBadBeat={!!badBeatUserId && row.userId === badBeatUserId}
            />
          ))}
        </section>
      )}

      {footer}
    </div>
  );
}

export default HandDetailView;
