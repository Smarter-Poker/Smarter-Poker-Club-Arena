import { useEffect, useId, useRef, useState } from 'react';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { gameChips } from '../../utils/bonusGameBudget';
import { soundService } from '../../services/SoundService';
import { triggerHaptic } from '../../services/HapticService';
import { TapHaptic } from '../haptics/TapHaptic';
import styles from './MinesGrid.module.css';
/**
 * The gem and the mine a tile turns over. The geometry is the original art; the
 * palette is the house one (2026-09-25): the gem is cut from light blue
 * (#45adff), royal blue (#1877f2) and chrome white, and the mine is a gunmetal
 * body on chrome spikes whose only colour is its bust-red fuse tip.
 */
export function GemArt({ mine = false }: { mine?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={styles.gem}>
      <defs>
        <linearGradient id={`${id}a`} x1="0" y1="0" x2=".8" y2="1">
          <stop stopColor="#f4f7fb" />
          <stop offset=".42" stopColor="#45adff" />
          <stop offset="1" stopColor="#1877f2" />
        </linearGradient>
        <radialGradient id={`${id}b`} cx=".35" cy=".25">
          <stop stopColor="#b8c3cd" />
          <stop offset=".38" stopColor="#3a4756" />
          <stop offset="1" stopColor="#0b1017" />
        </radialGradient>
      </defs>
      {mine ? (
        <g>
          <g stroke="#7f8c9b" strokeWidth="5" strokeLinecap="round">
            {[0, 45, 90, 135].map((a) => (
              <path key={a} d="M50 13V87" transform={`rotate(${a} 50 50)`} />
            ))}
          </g>
          <circle cx="50" cy="50" r="29" fill={`url(#${id}b)`} stroke="#9aa5b3" />
          <path d="M31 38Q37 25 51 26" fill="none" stroke="#e4e7ec" strokeWidth="3" opacity=".7" />
          <circle cx="54" cy="40" r="8" fill="#ff5b6e" />
          <circle cx="52" cy="38" r="3" fill="#ffd2d8" />
        </g>
      ) : (
        <g stroke="#e4e7ec" strokeWidth=".8" strokeLinejoin="round">
          <path d="M11 35L28 16H72L89 35L50 87Z" fill={`url(#${id}a)`} />
          <path d="M11 35H89L50 87Z" fill="#1877f2" />
          <path d="M11 35L34 37L50 87Z" fill="#45adff" />
          <path d="M34 37H65L50 87Z" fill="#bfe6ff" />
          <path d="M65 37L89 35L50 87Z" fill="#1466d6" />
          <path d="M28 16L34 37L11 35Z" fill="#8ecfff" />
          <path d="M28 16L50 16L34 37Z" fill="#f4f7fb" />
          <path d="M50 16L65 37H34Z" fill="#a9dcff" />
          <path d="M50 16H72L65 37Z" fill="#f4f7fb" />
          <path d="M72 16L89 35L65 37Z" fill="#6bbcff" />
          <path d="M20 22L22 14L24 22L32 24L24 26L22 34L20 26L12 24Z" fill="white" stroke="none" />
        </g>
      )}
    </svg>
  );
}
/** A signed chip amount: "+4.33 Chips", "-0.90 Chips", "0.00 Chips". */
export const signedChips = (amount: number) => {
  const cents = Math.round(amount * 100);
  return `${cents < 0 ? '-' : cents > 0 ? '+' : ''}${gameChips(Math.abs(cents) / 100)} Chips`;
};
/** The two readouts every Mines player weighs: what the board is worth now, above the
 * stake, and what the next safe tile adds. Before the first pick the board is worth
 * the stake itself (1.00x), so the profit starts at zero and the next tile's gain is
 * its prize above the stake. A finished round reads its booked chips against the stake. */
export function minesReadouts(input: {
  phase: 'idle' | 'open' | 'cashed' | 'lost';
  picks: number;
  prizes: readonly number[];
  betChips: number;
  payoutChips?: number;
}) {
  const { phase, picks, prizes, betChips, payoutChips } = input;
  const reached = picks > 0 ? (prizes[picks - 1] ?? betChips) : betChips;
  const value =
    phase === 'lost' ? (payoutChips ?? 0) : phase === 'cashed' ? (payoutChips ?? reached) : reached;
  const multiplier = betChips > 0 ? value / betChips : 0;
  const next = prizes[picks];
  return {
    totalLabel: `Total Profit (${multiplier.toFixed(2)}x)`,
    totalProfit: signedChips(value - betChips),
    nextLabel: 'Profit On Next Tile',
    nextProfit:
      phase === 'lost'
        ? 'Round Over'
        : phase === 'cashed'
          ? 'Win Booked'
          : next === undefined
            ? 'Limit Reached'
            : signedChips(next - value),
  };
}
/** Read by assistive technology, never drawn. */
const SPOKEN_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;
/** The cascade ripples out from the tile that ended the round, one ring at a time. */
export const cascadeDelay = (cell: number, origin: number, stepMs: number) => {
  const distance =
    Math.abs(Math.floor(cell / 5) - Math.floor(origin / 5)) + Math.abs((cell % 5) - (origin % 5));
  return distance * stepMs;
};
export default function MinesGrid({
  picked,
  mines,
  phase,
  busy,
  onPick,
  onSettled,
  roundId,
  prizes,
  betChips,
  payoutChips,
}: {
  picked: number[];
  mines: number[] | null;
  phase: 'idle' | 'open' | 'cashed' | 'lost';
  busy: boolean;
  onPick: (cell: number) => void;
  onSettled?: () => void;
  roundId?: string;
  /** Chip prizes per safe pick for this round or its quote. */
  prizes?: readonly number[];
  /** The stake in chips. */
  betChips?: number;
  /** The settled chips of a finished round. */
  payoutChips?: number;
}) {
  const terminal = phase === 'cashed' || phase === 'lost';
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  /**
   * THE BOARD IS HEARD AS IT TURNS (2026-09-26). A tile flips, or the mine
   * blasts, on the render that shows it, so the cue is played from the effect
   * that follows that render: a crystalline chime for a gem, climbing with
   * each gem found this round, a blast for the mine, the booked sting for a
   * win. Each fires once per change; a new round (or a board that mounts on a
   * round already in progress) starts from where it stands, silently.
   * Reduced motion keeps every cue: only the motion collapses.
   */
  const heard = useRef({ roundId, picks: picked.length, phase });
  const lastPick = picked[picked.length - 1];
  const lastIsMine = lastPick !== undefined && (mines?.includes(lastPick) ?? false);
  useEffect(() => {
    const was = heard.current;
    heard.current = { roundId, picks: picked.length, phase };
    if (was.roundId !== roundId) return;
    const picks = picked.length;
    if (phase === 'lost') {
      if (was.phase !== 'lost') soundService.playMinesExplosion(getAnimationSpeed());
      return;
    }
    if (picks > was.picks && !lastIsMine) soundService.playMinesGem(picks);
    if (phase === 'cashed' && was.phase !== 'cashed')
      soundService.playBonusBooked(
        betChips && betChips > 0 && payoutChips !== undefined ? payoutChips / betChips : 1
      );
  }, [roundId, phase, picked.length, lastIsMine, betChips, payoutChips]);
  const speed = getAnimationSpeed();
  const readouts =
    prizes && betChips !== undefined && betChips > 0
      ? minesReadouts({ phase, picks: picked.length, prizes, betChips, payoutChips })
      : null;
  const origin = picked[picked.length - 1] ?? 12;
  // Tiles a round in play can reach stay in the tab order even while they
  // cannot be pressed (a pick is out, or the tile is already turned): a
  // browser drops focus from a control the moment it is disabled, and every
  // pick used to throw a keyboard player back to the top of the page. Only a
  // board with no round in play is taken out of the tab order.
  const live = phase === 'open';
  // What the last pick turned over, said once by the status beside the board.
  const last = picked[picked.length - 1];
  const outcome =
    last === undefined ? '' : `Tile ${last + 1} Is A ${mines?.includes(last) ? 'Mine' : 'Gem'}.`;
  return (
    <>
      <div
        key={`${roundId}:${phase}`}
        className={styles.board}
        role="group"
        aria-label="Diamond Mines Board"
        data-motion="keep"
        data-terminal={terminal}
        // Before the first pick the board runs its attract: a slow light sweep.
        data-attract={!terminal && picked.length === 0 ? 'true' : undefined}
        style={
          terminal
            ? {
                animationDuration: `${1800 * speed}ms`,
                animationPlayState: visible ? 'running' : 'paused',
              }
            : undefined
        }
        onAnimationEnd={(event) => {
          if (terminal && event.target === event.currentTarget) onSettled?.();
        }}
      >
        {readouts && (
          <dl className={styles.readouts} aria-live="polite">
            <div>
              <dt>{readouts.totalLabel}</dt>
              <dd data-sign={readouts.totalProfit.startsWith('-') ? 'loss' : 'gain'}>
                {readouts.totalProfit}
              </dd>
            </div>
            <div>
              <dt>{readouts.nextLabel}</dt>
              <dd>{readouts.nextProfit}</dd>
            </div>
          </dl>
        )}
        <div className={styles.stage}>
          <div className={styles.grid}>
            {Array.from({ length: 25 }, (_, cell) => {
              const mine = mines?.includes(cell) ?? false,
                selected = picked.includes(cell),
                revealed = selected || mines !== null,
                // A tile the player turned over flips as it is picked; on the final
                // reveal the rest of the board turns over in a ripple from the last pick,
                // while the picks already showing stay put (the hit mine blasts instead).
                cascade = terminal && !selected,
                flip = revealed && (!terminal || cascade),
                refused = busy || selected;
              return (
                <button
                  key={cell}
                  type="button"
                  className={styles.tile}
                  data-revealed={revealed}
                  data-mine={revealed && mine}
                  data-picked={selected}
                  data-hit={selected && mine}
                  data-flip={flip}
                  data-cascade={cascade}
                  style={
                    cascade
                      ? {
                          animationDelay: `${cascadeDelay(cell, origin, 70 * speed)}ms`,
                          animationDuration: `${420 * speed}ms`,
                        }
                      : live && refused
                        ? // Reads and responds to a pointer exactly as a disabled tile did.
                          { pointerEvents: 'none' }
                        : undefined
                  }
                  aria-label={`Tile ${cell + 1}${revealed ? (mine ? ', Mine' : ', Gem') : ''}`}
                  disabled={!live}
                  aria-disabled={live ? refused : undefined}
                  onClick={() => {
                    if (!live || refused) return;
                    // Inside the tap, where a phone allows a buzz: the pick is felt
                    // the moment the finger lands (the gem or the mine is felt
                    // again when the board shows it).
                    triggerHaptic('selection');
                    onPick(cell);
                  }}
                >
                  <TapHaptic disabled={!live || refused} radius="3px" />
                  {revealed ? (
                    <GemArt mine={mine} />
                  ) : (
                    <>
                      <span className={styles.seal} aria-hidden="true">
                        ◆
                      </span>
                      <span className={styles.number}>{String(cell + 1).padStart(2, '0')}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <p className={styles.caption}>
          {mines
            ? phase === 'lost'
              ? 'A Mine Ended The Round. Every Mine And Gem Is Revealed.'
              : 'Win Booked. Every Mine And Gem Is Revealed.'
            : phase === 'open'
              ? 'Choose A Tile. Find A Diamond.'
              : '25 Tiles. Your Next Discovery Awaits.'}
        </p>
      </div>
      {/* Outside the keyed board, which a finished round rebuilds for its reveal:
        a live region is only read out when it changes, never when it is new.
        Hidden by its own style, so it stays unseen wherever the board is drawn. */}
      <p role="status" aria-live="polite" style={SPOKEN_ONLY}>
        {outcome}
      </p>
    </>
  );
}
