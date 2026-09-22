import { useEffect, useRef, useState } from 'react';
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

/** The primary and upgraded wheels reveal one durable receipt, without a second debit. */
export function WheelExperience({
  segments,
  upgradeSegments = [],
  receipt,
  spinKey,
  spinning,
  onFinished,
  size,
  autoContinue = false,
  fitViewport = false,
}: {
  segments: WheelSegment[];
  upgradeSegments?: WheelSegment[];
  receipt: WheelSpinResult | null;
  spinKey: number;
  spinning: boolean;
  onFinished: () => void;
  size: number;
  autoContinue?: boolean;
  fitViewport?: boolean;
}) {
  // The wheels stay mounted across spins (owner ruling 2026-09-21, R7: the
  // next spin leaves from the idle angle, never from zero), so a new spin key
  // starts its own phase record instead of a remount resetting this one.
  const [phaseRecord, setPhaseRecord] = useState<{
    key: number;
    phase: 'primary' | 'prize' | 'secondary' | 'bonus' | 'finished';
  }>({ key: spinKey, phase: 'primary' });
  const phase = phaseRecord.key === spinKey ? phaseRecord.phase : 'primary';
  const setPhase = (next: typeof phaseRecord.phase) =>
    setPhaseRecord({ key: spinKey, phase: next });
  const secondary = phase === 'secondary' || phase === 'bonus';
  const expanded = phase !== 'primary' && receipt?.outcome.kind === 'upgrade';
  const upperSegments = receipt?.secondary?.segments ?? upgradeSegments;
  const mainStage = useRef<HTMLDivElement>(null);
  const upgradeStage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fitViewport || !spinning || (phase !== 'primary' && phase !== 'secondary')) return;
    const stage = phase === 'secondary' ? upgradeStage.current : mainStage.current;
    stage?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [spinning, phase, fitViewport]);
  const prize = secondary ? receipt?.secondary?.outcome : receipt?.outcome;
  const showPrize = (phase === 'prize' || phase === 'bonus') && prize && receipt;
  const finish = () => {
    setPhase('finished');
    onFinished();
  };
  return (
    <>
      <div
        className={styles.stack}
        role="group"
        data-wheel-assembly="concentric"
        data-upgrade-reveal={expanded ? 'open' : 'peek'}
        data-fit-viewport={fitViewport || undefined}
        aria-label="Diamond Spins Prize Wheel"
      >
        {upperSegments.length > 0 && (
          <div
            className={styles.upgradeStage}
            ref={upgradeStage}
            data-active={secondary || undefined}
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
              onLanded={() => setPhase('bonus')}
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
              else setPhase('prize');
            }}
          />
        </div>
      </div>
      {showPrize && (
        <WheelWinReveal
          key={secondary ? 'bonus-prize' : 'primary-prize'}
          prize={prize}
          autoContinue={autoContinue}
          title={wheelPrizeTitle(prize)}
          detail={
            prize.kind === 'upgrade'
              ? 'Your Upgrade Wheel Opens With Super Games And Instant Chip Wins.'
              : prize.kind === 'bonus'
                ? 'Your Game Is Ready. Choose Your Bonus Setup Before Playing.'
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
              if (receipt.secondary) setPhase('secondary');
            } else finish();
          }}
        />
      )}
    </>
  );
}
