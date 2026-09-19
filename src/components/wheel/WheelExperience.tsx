import { useEffect, useRef, useState } from 'react';
import type { WheelSegment, WheelSpinResult } from '../../services/DiamondWheelService';
import DiamondWheel from './DiamondWheel';
import { WheelWinReveal } from './WheelWinReveal';
import styles from './WheelExperience.module.css';

const inventoryNames: Record<string, string> = {
  throwable: 'Throwable',
  time_bank_seconds: 'Time Bank',
  rabbit_hunt: 'Rabbit Hunt',
};

const gameNames = {
  plinko: 'Diamond Plinko',
  crash: 'Diamond Crash',
  crossing: 'Donkey Cross',
  mines: 'Diamond Mines',
};
const superGameNames = {
  plinko: 'Super Plinko',
  crash: 'Super Crash',
  crossing: 'Super Donkey Cross',
  mines: 'Super Diamond Mines',
};

export function wheelPrizeTitle(prize: WheelSpinResult['outcome']): string {
  if (prize.kind === 'bonus' && prize.game)
    return prize.multiplier === 2 ? superGameNames[prize.game] : gameNames[prize.game];
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
}: {
  segments: WheelSegment[];
  upgradeSegments?: WheelSegment[];
  receipt: WheelSpinResult | null;
  spinKey: number;
  spinning: boolean;
  onFinished: () => void;
  size: number;
  autoContinue?: boolean;
}) {
  const [phase, setPhase] = useState<'primary' | 'prize' | 'secondary' | 'bonus' | 'finished'>(
    'primary'
  );
  const secondary = phase === 'secondary' || phase === 'bonus';
  const upperSegments = receipt?.secondary?.segments ?? upgradeSegments;
  const mainStage = useRef<HTMLDivElement>(null);
  const upgradeStage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!spinning || (phase !== 'primary' && phase !== 'secondary')) return;
    const stage = phase === 'secondary' ? upgradeStage.current : mainStage.current;
    stage?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [spinning, phase]);
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
              showSelector={phase !== 'primary' && receipt?.outcome.kind === 'upgrade'}
              idleDirection={-1}
              size={size}
              presentation="assembly"
              onLanded={() => setPhase('bonus')}
            />
          </div>
        )}
        <div className={styles.mainStage} ref={mainStage}>
          <DiamondWheel
            segments={segments}
            presentation="assembly"
            landingOrd={receipt?.outcome.ord ?? null}
            spinKey={spinKey}
            spinning={spinning && phase === 'primary'}
            size={size}
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
