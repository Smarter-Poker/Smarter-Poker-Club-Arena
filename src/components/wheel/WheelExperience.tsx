import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { WheelSegment, WheelSpinResult } from '../../services/DiamondWheelService';
import DiamondWheel from './DiamondWheel';
import { WheelWinReveal } from './WheelWinReveal';
import { diamondGameTitle } from '../../utils/diamondGameTitles';
import styles from './WheelExperience.module.css';

const inventoryNames: Record<string, string> = {
  throwable: 'Throwable',
  time_bank_seconds: 'Time Bank',
  rabbit_hunt: 'Rabbit Hunt',
};

export function wheelPrizeTitle(prize: WheelSpinResult['outcome']): string {
  if (prize.kind === 'bonus' && prize.game) return diamondGameTitle(prize.game, prize.multiplier);
  if (prize.kind === 'upgrade') return 'Bonus Upgrade';
  const amount = prize.amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (prize.kind === 'chips') return `${amount} ${prize.amount === 1 ? 'Chip' : 'Chips'}`;
  if (prize.kind === 'diamonds') return `${amount} ${prize.amount === 1 ? 'Diamond' : 'Diamonds'}`;
  if (prize.grants) {
    const name =
      prize.kind === 'time_bank'
        ? 'Time Bank'
        : prize.kind === 'rabbit_hunt'
          ? 'Rabbit Hunt'
          : 'Throwable';
    return `${amount} ${name}${prize.amount === 1 ? '' : 's'}`;
  }
  return prize.label;
}

/** The instruction the upgrade ring waits under. Title Case, no em dash (10.7). */
export const UPGRADE_SPIN_INSTRUCTION = 'Swipe Or Tap The Wheel To Spin';

/**
 * A swipe is a pointer that travelled this far. A tap is a pointer that went
 * down and came up without travelling it. Either starts the upgrade ring; a
 * pointer that merely moves over the wheel, or is cancelled, starts nothing.
 */
export const UPGRADE_SWIPE_PX = 12;

type Phase = 'primary' | 'prize' | 'awaitUpgrade' | 'secondary' | 'bonus' | 'finished';

/**
 * The primary and upgraded wheels reveal one durable receipt, without a second debit.
 *
 * NOTHING HERE ADVANCES ON A CLOCK (owner ruling 2026-09-21, R1, R9, R19).
 * The main wheel lands, and then the player acts: Continue on an instant
 * prize, Play Game on a bonus game, Open Upgrade Wheel on an upgrade, and
 * then a swipe or a tap on the ring itself before it turns. The one exception
 * is a run the player started (`runMode`): its spins land straight onto the
 * run's tally, because the player asked for N spins back to back and reads
 * the prizes together at the end. Even in a run the upgrade ring waits for
 * the gesture.
 */
export function WheelExperience({
  segments,
  upgradeSegments = [],
  receipt,
  spinKey,
  spinning,
  onFinished,
  size,
  runMode = false,
  fitViewport = false,
}: {
  segments: WheelSegment[];
  upgradeSegments?: WheelSegment[];
  receipt: WheelSpinResult | null;
  spinKey: number;
  spinning: boolean;
  onFinished: () => void;
  size: number;
  /** A run the player started: prizes go to the tally, no reveal opens per spin. */
  runMode?: boolean;
  fitViewport?: boolean;
}) {
  /* The phase belongs to one spin. A new spinKey starts at 'primary' in the
     same render, whether or not the page remounts this component per spin -
     and it no longer does: the wheels stay mounted across spins (owner ruling
     2026-09-21, R7), so the next spin leaves from the idle angle, never from
     zero, and this record is what resets instead. */
  const [phaseFor, setPhaseFor] = useState<{ key: number; phase: Phase }>({
    key: spinKey,
    phase: 'primary',
  });
  const phase: Phase = phaseFor.key === spinKey ? phaseFor.phase : 'primary';
  const setPhase = (next: Phase) => setPhaseFor({ key: spinKey, phase: next });
  const secondary = phase === 'secondary' || phase === 'bonus';
  const awaiting = phase === 'awaitUpgrade';
  const expanded = phase !== 'primary' && receipt?.outcome.kind === 'upgrade';
  const upperSegments = receipt?.secondary?.segments ?? upgradeSegments;
  const mainStage = useRef<HTMLDivElement>(null);
  const upgradeStage = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (fitViewport || !spinning || (phase !== 'primary' && phase !== 'secondary')) return;
    const stage = phase === 'secondary' ? upgradeStage.current : mainStage.current;
    stage?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [spinning, phase, fitViewport]);
  useEffect(() => {
    if (awaiting) upgradeStage.current?.focus?.({ preventScroll: true });
  }, [awaiting]);
  const prize = secondary ? receipt?.secondary?.outcome : receipt?.outcome;
  const showPrize = (phase === 'prize' || phase === 'bonus') && prize && receipt;
  const finish = () => {
    setPhase('finished');
    onFinished();
  };
  /** The player's gesture, and nothing else, starts the upgrade ring. */
  const startUpgradeSpin = () => {
    if (phase !== 'awaitUpgrade' || !receipt?.secondary) return;
    pointer.current = null;
    setPhase('secondary');
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!awaiting) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const down = pointer.current;
    if (!awaiting || !down || down.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) >= UPGRADE_SWIPE_PX)
      startUpgradeSpin();
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const down = pointer.current;
    if (!awaiting || !down || down.id !== event.pointerId) return;
    startUpgradeSpin();
  };
  const onPointerCancel = () => {
    pointer.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!awaiting || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    startUpgradeSpin();
  };
  return (
    <>
      <div
        className={styles.stack}
        role="group"
        data-wheel-assembly="concentric"
        data-upgrade-reveal={expanded ? 'open' : 'peek'}
        data-fit-viewport={fitViewport || undefined}
        data-awaiting-upgrade={awaiting || undefined}
        aria-label="Diamond Spins Prize Wheel"
      >
        {upperSegments.length > 0 && (
          <div
            className={styles.upgradeStage}
            ref={upgradeStage}
            data-active={secondary || undefined}
            data-awaiting={awaiting || undefined}
            role={awaiting ? 'button' : undefined}
            tabIndex={awaiting ? 0 : undefined}
            aria-label={awaiting ? UPGRADE_SPIN_INSTRUCTION : undefined}
            onPointerDown={awaiting ? onPointerDown : undefined}
            onPointerMove={awaiting ? onPointerMove : undefined}
            onPointerUp={awaiting ? onPointerUp : undefined}
            onPointerCancel={awaiting ? onPointerCancel : undefined}
            onKeyDown={awaiting ? onKeyDown : undefined}
          >
            <DiamondWheel
              segments={upperSegments}
              landingOrd={receipt?.secondary?.outcome.ord ?? null}
              spinKey={spinKey}
              spinning={spinning && phase === 'secondary'}
              upgraded
              upgradeExpanded={expanded}
              showSelector={expanded}
              idleDirection={-1}
              fitViewport={fitViewport}
              size={size}
              presentation="assembly"
              paused={Boolean(showPrize)}
              onLanded={() => {
                if (runMode) finish();
                else setPhase('bonus');
              }}
            />
          </div>
        )}
        <div className={styles.mainStage} ref={mainStage}>
          <DiamondWheel
            segments={segments}
            faceScale={upperSegments.length > 0 ? (expanded ? 0.56 : 0.91) : 1}
            presentation="assembly"
            landingOrd={receipt?.outcome.ord ?? null}
            spinKey={spinKey}
            spinning={spinning && phase === 'primary'}
            fitViewport={fitViewport}
            size={size}
            paused={Boolean(showPrize)}
            onLanded={() => {
              if (receipt?.outcome.kind === 'nothing') finish();
              else if (receipt?.outcome.kind === 'upgrade' && receipt.secondary && runMode)
                setPhase('awaitUpgrade');
              else if (runMode) finish();
              else setPhase('prize');
            }}
          />
        </div>
        {awaiting && (
          <p className={styles.instruction} role="status" aria-live="polite">
            <span className={styles.instructionText}>{UPGRADE_SPIN_INSTRUCTION}</span>
          </p>
        )}
      </div>
      {showPrize && (
        <WheelWinReveal
          key={secondary ? 'bonus-prize' : 'primary-prize'}
          prize={prize}
          title={wheelPrizeTitle(prize)}
          detail={
            prize.kind === 'upgrade'
              ? 'Your Upgrade Wheel Opens With Super Games And Instant Chip Wins. You Spin It Yourself.'
              : prize.kind === 'bonus'
                ? 'Your Game Is Ready. Tap Play Game When You Are Ready To Play It.'
                : prize.grants
                  ? prize.grants
                      .map(
                        (g) =>
                          `${g.uses.toLocaleString()} ${inventoryNames[g.feature] ?? 'Reward'}${g.uses === 1 ? '' : 's'}`
                      )
                      .join(' + ') + ' Added To Your Account.'
                  : 'Your Prize Has Been Added To Your Account.'
          }
          onOpen={() => {
            if (prize.kind === 'upgrade') {
              if (receipt.secondary) setPhase('awaitUpgrade');
              else finish();
            } else finish();
          }}
        />
      )}
    </>
  );
}
