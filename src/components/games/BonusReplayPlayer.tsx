import { useEffect, useMemo, useRef, useState } from 'react';
import type { BonusReplay } from '../../services/DiamondReplayService';
import { bonusReplayTitle } from '../../services/DiamondReplayService';
import { useMeasuredWidth } from '../../hooks/useMeasuredWidth';
import { getAnimationSpeed } from '../../utils/animationSpeed';
import { crashMultiplierCents, multiplierLabel } from '../../utils/diamondGamesFairness';
import PlinkoBoard from '../plinko/PlinkoBoard';
import CrashCurve from '../crash/CrashCurve';
import ChoiceScene from './ChoiceScene';
import styles from './BonusReplay.module.css';

/** Presentation of an immutable receipt; this component never calls a game RPC. */
export default function BonusReplayPlayer({ replay }: { replay: BonusReplay }) {
  const [epoch, setEpoch] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [landed, setLanded] = useState(0);
  const [terminal, setTerminal] = useState(false);
  const [finished, setFinished] = useState(false);
  const clock = useRef(0);
  const activeRun = useRef<number | null>(null);
  const [measure, width] = useMeasuredWidth<HTMLDivElement>();
  const paths = useMemo(
    () => (replay.game === 'plinko' ? replay.data.drops.map((d) => d.path_bits) : null),
    [replay]
  );
  const choiceDuration =
    replay.game === 'mines' || replay.game === 'crossing'
      ? replay.data.picked.length * 1500 * getAnimationSpeed()
      : 0;
  // Settlement can be acknowledged long after the flight ended. Replay only
  // through the sealed ending, not the time an offline player took to recover it.
  const duration =
    replay.game === 'crash'
      ? Math.min(
          replay.data.elapsed_ms,
          Math.ceil(
            (Math.log(
              (replay.data.cashout_cents ??
                Math.min(replay.data.cap_cents, replay.data.crash_cents)) / 100
            ) /
              replay.data.growth_k) *
              1000
          )
        )
      : choiceDuration;
  useEffect(() => {
    if (!playing || terminal || replay.game === 'plinko') return;
    let frame: number;
    let hiddenAt: number | null = document.hidden ? performance.now() : null;
    const visibility = () => {
      if (document.hidden) hiddenAt ??= performance.now();
      else if (hiddenAt !== null) {
        clock.current += performance.now() - hiddenAt;
        hiddenAt = null;
      }
    };
    const tick = () => {
      if (!document.hidden) {
        const next = Math.min(duration, performance.now() - clock.current);
        setElapsed(next);
        if (next >= duration) {
          setTerminal(true);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [playing, terminal, duration, replay.game]);
  useEffect(
    () => () => {
      activeRun.current = null;
    },
    []
  );
  const complete = () => {
    if (activeRun.current !== epoch) return;
    activeRun.current = null;
    setPlaying(false);
    setFinished(true);
  };
  const play = () => {
    if (activeRun.current !== null) return;
    activeRun.current = epoch + 1;
    setElapsed(0);
    setLanded(0);
    setFinished(false);
    setTerminal(false);
    setEpoch((n) => n + 1);
    clock.current = performance.now();
    setPlaying(true);
  };
  const choices =
    replay.game === 'mines' || replay.game === 'crossing'
      ? Math.min(replay.data.picked.length, Math.floor(elapsed / (1500 * getAnimationSpeed())))
      : 0;
  const amount = replay.payout_chips.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (
    <section className={styles.player} aria-label="Bonus Replay">
      <header>
        <p className="sc-label sc-ink--blue">Recorded Bonus</p>
        <h2>{bonusReplayTitle(replay)}</h2>
        <p>
          {replay.diamonds.toLocaleString()} Diamonds · {amount} Chips Awarded
        </p>
      </header>
      <div className={styles.stage} ref={measure}>
        {replay.game === 'plinko' ? (
          <PlinkoBoard
            key={epoch}
            width={width}
            multipliersCents={replay.data.multipliers_cents}
            path={null}
            dropKey={epoch}
            batchPathBits={epoch ? paths : null}
            restingSlot={null}
            onProgress={(count) => {
              if (activeRun.current === epoch) setLanded(count);
            }}
            onLanded={complete}
          />
        ) : replay.game === 'crash' ? (
          <CrashCurve
            key={epoch}
            width={width}
            height={Math.max(260, Math.min(520, width * 0.7))}
            phase={terminal ? replay.data.status : playing ? 'open' : 'idle'}
            growthK={replay.data.growth_k}
            capCents={replay.data.cap_cents}
            startedAtLocalMs={null}
            replayElapsedMs={elapsed}
            finalCents={
              terminal
                ? (replay.data.cashout_cents ??
                  Math.min(replay.data.cap_cents, replay.data.crash_cents))
                : null
            }
            cashoutCents={terminal ? replay.data.cashout_cents : null}
            crashCents={terminal ? replay.data.crash_cents : null}
            autoCashoutCents={replay.data.auto_cashout_cents}
            onSettled={terminal ? complete : undefined}
          />
        ) : (
          <ChoiceScene
            key={epoch}
            game={replay.game}
            picked={replay.data.picked.slice(0, choices)}
            phase={terminal ? replay.data.status : epoch ? 'open' : 'idle'}
            mines={terminal ? replay.data.mine_cells : null}
            roadEnd={terminal ? replay.data.road_end : null}
            busy
            onPick={() => undefined}
            roundId={`replay-${epoch}`}
            onSettled={terminal ? complete : undefined}
          />
        )}
      </div>
      <p className={styles.progress} role="status">
        {replay.game === 'plinko'
          ? `${landed.toLocaleString()} / ${replay.data.drops.length.toLocaleString()} Drops`
          : replay.game === 'crash'
            ? multiplierLabel(
                terminal
                  ? (replay.data.cashout_cents ?? replay.data.crash_cents)
                  : crashMultiplierCents(replay.data.growth_k, elapsed, replay.data.cap_cents)
              )
            : `${choices} / ${replay.data.picked.length} Choices`}
      </p>
      {finished && <p className="sc-ink--gold">Prize Awarded: {amount} Chips</p>}
      {(replay.game === 'mines' || replay.game === 'crossing') && (
        <p className={styles.note}>
          Choices Replay In Their Recorded Order. The Time Between Choices Is Recreated.
        </p>
      )}
      <button type="button" className={styles.action} disabled={playing} onClick={play}>
        {playing ? 'Playing Replay' : epoch ? 'Watch Again' : 'Watch Replay'}
      </button>
    </section>
  );
}
