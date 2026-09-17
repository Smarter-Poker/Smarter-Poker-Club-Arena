import { useState } from 'react';
import type { WheelSegment, WheelSpinResult } from '../../services/DiamondWheelService';
import DiamondWheel from './DiamondWheel';
import { WheelWinReveal } from './WheelWinReveal';

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

export function wheelPrizeTitle(prize: WheelSpinResult['outcome']): string {
  if (prize.kind === 'bonus' && prize.game) return gameNames[prize.game];
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
  receipt,
  spinKey,
  spinning,
  onFinished,
  size,
  autoContinue = false,
}: {
  segments: WheelSegment[];
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
  const prize = secondary ? receipt?.secondary?.outcome : receipt?.outcome;
  const showPrize = (phase === 'prize' || phase === 'bonus') && prize && receipt;
  const finish = () => {
    setPhase('finished');
    onFinished();
  };
  return (
    <>
      <DiamondWheel
        key={secondary ? 'secondary' : 'primary'}
        segments={secondary ? (receipt?.secondary?.segments ?? []) : segments}
        landingOrd={prize?.ord ?? null}
        spinKey={spinKey}
        spinning={spinning && (phase === 'primary' || phase === 'secondary')}
        upgraded={secondary}
        size={size}
        onLanded={() => {
          if (prize?.kind === 'nothing')
            finish(); // Historical receipts keep their actual result.
          else setPhase(secondary ? 'bonus' : 'prize');
        }}
      />
      {showPrize && (
        <WheelWinReveal
          key={secondary ? 'bonus-prize' : 'primary-prize'}
          prize={prize}
          autoContinue={autoContinue}
          title={wheelPrizeTitle(prize)}
          detail={
            prize.kind === 'upgrade'
              ? 'Your Bonus Wheel Opens With Upgraded Payouts.'
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
