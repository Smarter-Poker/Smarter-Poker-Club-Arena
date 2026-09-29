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

import { useMemo } from 'react';
import CardImage, { CardBack } from '../table/CardImage';
import { cardKey } from '../../utils/handEvaluator';
import type { ReplayModel, ReplayRow, ReplayShowdownRow } from '../../utils/handReplay';
import type { HeroHandFacts } from '../../services/HandHistoryService';
import { computeEquity, type EquityResult } from '../../utils/equity';
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
  /**
   * PHASE 2 (2026-09-05): the viewer's own all-in equity and EV facts for this
   * hand (`ca_hand_facts`, RLS-scoped to the viewer). Renders the "All-In"
   * block when the hand had one; nothing otherwise.
   */
  viewerFacts?: HeroHandFacts | null;
}

const STREET_WORD: Record<string, string> = {
  preflop: 'Preflop',
  pineapple_discard: 'At The Discard',
  flop: 'On The Flop',
  turn: 'On The Turn',
  river: 'On The River',
};

/**
 * The engine's own all-in equity and what it said the hand was worth, beside
 * what actually happened. `all_in_equity` is a fraction; every chip figure is
 * money. Nothing here is computed on the client; it is the record.
 */
function AllInFacts({ facts }: { facts: HeroHandFacts }) {
  if (!facts.was_all_in || facts.all_in_equity === null) return null;
  const pct = Math.round(facts.all_in_equity * 1000) / 10;
  const luck = facts.ev_returned === null ? null : money(facts.net - facts.ev_net);
  const above = facts.net - facts.ev_net;
  return (
    <section className="hdv__allin" aria-label="All In">
      <header className="hdv__section-head">
        All In {STREET_WORD[facts.all_in_street || ''] || ''}
      </header>
      <div className="hdv__allin-grid">
        <div className="hdv__allin-cell">
          <span className="hdv__allin-label">Your Equity</span>
          <span className="hdv__allin-value">{pct}%</span>
        </div>
        {facts.all_in_at_risk !== null && (
          <div className="hdv__allin-cell">
            <span className="hdv__allin-label">At Risk</span>
            <span className="hdv__allin-value">{money(facts.all_in_at_risk)}</span>
          </div>
        )}
        {facts.ev_returned !== null && (
          <div className="hdv__allin-cell">
            <span className="hdv__allin-label">Expected Back</span>
            <span className="hdv__allin-value">{money(facts.ev_returned)}</span>
          </div>
        )}
        <div className="hdv__allin-cell">
          <span className="hdv__allin-label">Got Back</span>
          <span className="hdv__allin-value">{money(facts.returned)}</span>
        </div>
        <div className="hdv__allin-cell">
          <span className="hdv__allin-label">Expected Net</span>
          <span className={`hdv__allin-value${facts.ev_net >= 0 ? ' is-up' : ' is-down'}`}>
            {facts.ev_net >= 0 ? '+' : '-'}
            {money(Math.abs(facts.ev_net))}
          </span>
        </div>
        <div className="hdv__allin-cell">
          <span className="hdv__allin-label">Actual Net</span>
          <span className={`hdv__allin-value${facts.net >= 0 ? ' is-up' : ' is-down'}`}>
            {facts.net >= 0 ? '+' : '-'}
            {money(Math.abs(facts.net))}
          </span>
        </div>
      </div>
      {luck !== null && (
        <div className={`hdv__allin-luck${above >= 0 ? ' is-up' : ' is-down'}`}>
          {above >= 0 ? 'Ran Above Expectation By ' : 'Ran Below Expectation By '}
          {money(Math.abs(above))}
        </div>
      )}
    </section>
  );
}

/**
 * Per-street equity, priced only where every contender's cards are known.
 * Exact where the runout can be enumerated; sampled preflop and marked so.
 */
function useStreetEquities(model: ReplayModel): Map<string, EquityResult> {
  return useMemo(() => {
    const out = new Map<string, EquityResult>();
    const holeOf = new Map<string, ReplayModel['players'][number]['hole']>();
    for (const p of model.players) holeOf.set(p.userId, p.hole || p.privateHole || null);
    for (const street of model.streets) {
      if (street.key === 'showdown' || street.key === 'pineapple_discard') continue;
      if (street.contenders.length < 2) continue;
      const players: Array<{
        userId: string;
        hole: NonNullable<ReplayModel['players'][number]['hole']>;
      }> = [];
      let allKnown = true;
      for (const uid of street.contenders) {
        const hole = holeOf.get(uid);
        if (!hole || hole.length < 2) {
          allKnown = false;
          break;
        }
        players.push({ userId: uid, hole });
      }
      if (!allKnown) continue;
      /* Omaha evaluates 60 five-card hands per holding per runout; a sampled
         preflop there is capped lower so an expanded row cannot stall a phone. */
      const omaha = /plo|flo|omaha/i.test(String(model.gameVariant || ''));
      const r = computeEquity({
        players,
        board: street.board,
        variant: model.gameVariant,
        samples: omaha ? 600 : 1500,
      });
      if (r) out.set(street.key, r);
    }
    return out;
  }, [model]);
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
        {/* Both axes when the record has both (2026-09-13): a run-it-twice
            hand with a side pot used to show "Board 2" and never which pot
            the share came out of, because the board label always won. */}
        <span className="hdv__sd-pot">
          {row.boardLabel && row.potSlices?.length
            ? `${row.boardLabel} · ${row.potLabel}`
            : row.boardLabel || row.potLabel}
        </span>
      </div>
    </div>
  );
}

/**
 * KILL POTS (rule manifest kill-v1): what the record says about kills on this
 * hand, in the drop row's grammar. A kill hand states its effective limits
 * beside the base ones, the kill blind and the killer; the hand that set the
 * next kill names the killer; a kill that did not play says why. Every figure
 * is the record's own. Nothing renders on a hand with no kill facts.
 */
function KillPotFacts({ model }: { model: ReplayModel }) {
  const k = model.killPot;
  if (!k) return null;
  return (
    <>
      {k.hand && (
        <div className="hdv__drop hdv__kill" aria-label={k.hand.name}>
          <strong>{k.hand.name}</strong>
          <span>
            Limits <strong>{k.hand.effectiveLimits}</strong>
          </span>
          <span>
            Base <strong>{k.hand.baseLimits}</strong>
          </span>
          <span>
            Kill Blind <strong>{money(k.hand.killBlind)}</strong>
          </span>
          <span>
            Killer{' '}
            <strong>
              {k.hand.killerName}, Seat {k.hand.killerSeat}
            </strong>
          </span>
        </div>
      )}
      {k.cancelled && (
        <div className="hdv__drop hdv__kill">
          <strong>Kill Cancelled</strong>
          <span>{k.cancelled.reasonText}</span>
          {k.cancelled.killerSeat > 0 && (
            <span>
              Killer{' '}
              <strong>
                {k.cancelled.killerName}, Seat {k.cancelled.killerSeat}
              </strong>
            </span>
          )}
        </div>
      )}
      {k.next && (
        <div className="hdv__drop hdv__kill">
          <strong>Next Hand: {k.next.name}</strong>
          <span>
            Killer{' '}
            <strong>
              {k.next.killerName}, Seat {k.next.killerSeat}
            </strong>
          </span>
        </div>
      )}
    </>
  );
}

export function HandDetailView({
  model,
  currentUserId,
  currentUserName,
  footer,
  badge,
  badBeatUserId,
  viewerFacts,
}: HandDetailViewProps) {
  const equities = useStreetEquities(model);
  const nameOf = (uid: string) => model.players.find((p) => p.userId === uid)?.username || 'Player';
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

      <KillPotFacts model={model} />

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

          {/* PHASE 2: what each known hand had made on this street, and - when
              every player still in had known cards - each one's chance to win
              from here. Exact where the runout was enumerated; a sampled
              preflop figure carries a tilde. */}
          {street.key !== 'showdown' &&
            (street.madeHands.length > 0 || equities.has(street.key)) && (
              <div className="hdv__street-facts">
                {street.madeHands.map((m) => {
                  const eq = equities.get(street.key)?.equities.find((e) => e.userId === m.userId);
                  return (
                    <span
                      key={`mh-${street.key}-${m.userId}`}
                      className={`hdv__fact${isYou(m.userId, nameOf(m.userId)) ? ' is-you' : ''}`}
                    >
                      <span className="hdv__fact-name">{nameOf(m.userId)}</span>
                      <span className="hdv__fact-hand">{m.name}</span>
                      {eq && (
                        <span className="hdv__fact-eq">
                          {equities.get(street.key)?.exact ? '' : '~'}
                          {eq.pct}%
                        </span>
                      )}
                    </span>
                  );
                })}
                {street.madeHands.length === 0 &&
                  equities.get(street.key)?.equities.map((e) => (
                    <span
                      key={`eq-${street.key}-${e.userId}`}
                      className={`hdv__fact${isYou(e.userId, nameOf(e.userId)) ? ' is-you' : ''}`}
                    >
                      <span className="hdv__fact-name">{nameOf(e.userId)}</span>
                      <span className="hdv__fact-eq">
                        {equities.get(street.key)?.exact ? '' : '~'}
                        {e.pct}%
                      </span>
                    </span>
                  ))}
                {equities.get(street.key)?.highOnly && (
                  <span className="hdv__fact-note">High Half</span>
                )}
              </div>
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

      {viewerFacts && <AllInFacts facts={viewerFacts} />}

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
