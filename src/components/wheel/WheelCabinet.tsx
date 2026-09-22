import type { ReactNode } from 'react';
import type { DeckBay } from '../console/DeckConsole';
import { type PlateButtonProps, type ConsoleInk } from '../console/SpadeConsole';
import { WheelPrizeArt } from './WheelPrizeArt';
import { wheelPrizeTitle } from './WheelExperience';
import type { WheelSegment, WheelSegmentKind } from '../../services/DiamondWheelService';
import styles from './WheelCabinet.module.css';

/** The wheel and its attached controls share one available play viewport. */
export function WheelCabinet({
  title,
  titleId,
  bays,
  primary,
  secondary,
  setup,
  navigation,
  notice,
  children,
}: {
  title: string;
  titleId?: string;
  pill?: string;
  pillInk?: ConsoleInk;
  eyebrow?: string;
  bays: DeckBay[];
  primary?: PlateButtonProps;
  secondary?: PlateButtonProps;
  setup?: ReactNode;
  navigation?: ReactNode;
  notice?: ReactNode;
  children?: ReactNode;
} & Record<string, unknown>) {
  return (
    <section className={styles.cabinet} aria-labelledby={titleId}>
      <header className={styles.heading}>
        <h1 id={titleId}>{title}</h1>
      </header>
      <div className={styles.wheel}>{children}</div>
      <aside className={styles.controls} aria-label="Diamond Spins Controls">
        <div className={styles.controlHeading}>{navigation}</div>
        {setup}
        <div className={styles.dashboard}>
          <dl className={styles.metrics}>
            {bays.map((bay) => (
              <div key={bay.label}>
                <dt>{bay.label}</dt>
                <dd data-ink={bay.ink}>{bay.value}</dd>
              </div>
            ))}
          </dl>
          <div className={styles.actions}>
            {secondary && (
              <button
                type="button"
                className={styles.secondary}
                onClick={secondary.onClick}
                disabled={secondary.disabled}
                data-ink={secondary.ink}
              >
                {secondary.label}
              </button>
            )}
            {primary && (
              <button
                type="button"
                className={styles.primary}
                onClick={primary.onClick}
                disabled={primary.disabled}
                data-ink={primary.ink}
              >
                {primary.label}
              </button>
            )}
          </div>
        </div>
        {notice && <div className={styles.notice}>{notice}</div>}
      </aside>
    </section>
  );
}

/**
 * THE MIX THE PLAYER ACTUALLY FACES (owner ruling 2026-09-21, R13, and the
 * wheel v4 contract, section 1). Three buckets, read off the table the server
 * sent and never written down here: GAMES is the four bonus games, the
 * Diamonds cards and the Upgrade that opens the Super games; CHIPS is the
 * instant chip wins; ITEMS is Throwables, Time Bank and Rabbit Hunt.
 *
 * It is computed from the segments because that is the only honest source: a
 * VIP is served a table with no items on it at all (R2), a host may lock a
 * tier, and a number typed into this file would keep saying 20% after the
 * server had stopped sending any.
 */
const MIX_BUCKETS: Record<'games' | 'chips' | 'items', WheelSegmentKind[]> = {
  games: ['bonus', 'diamonds', 'upgrade'],
  chips: ['chips'],
  items: ['throwables', 'time_bank', 'rabbit_hunt'],
};

export function wheelPrizeMix(segments: WheelSegment[]): {
  games: number;
  chips: number;
  items: number;
} {
  const weigh = (list: WheelSegment[]) =>
    list.reduce((sum, s) => sum + (s.weight > 0 ? s.weight : 0), 0);
  const total = weigh(segments);
  const share = (kinds: WheelSegmentKind[]) =>
    total > 0 ? weigh(segments.filter((s) => kinds.includes(s.kind))) / total : 0;
  return {
    games: share(MIX_BUCKETS.games),
    chips: share(MIX_BUCKETS.chips),
    items: share(MIX_BUCKETS.items),
  };
}

/**
 * A share as the player reads it: one decimal, ALWAYS ROUNDED DOWN so a
 * figure is never overstated, and a trailing .0 dropped - the same rule
 * compactChips follows for money (Dan 2026-09-09).
 */
export function sharePercent(fraction: number): string {
  const tenths = Math.floor(Math.max(0, fraction) * 1000) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}%`;
}

export function WheelPrizeGallery({
  segments,
  vip = false,
}: {
  segments: WheelSegment[];
  /** This player holds an active or lifetime VIP card (`state.vip`, R2). */
  vip?: boolean;
}) {
  const mix = wheelPrizeMix(segments);
  return (
    <section className={styles.prizes} aria-label="Wheel Prizes">
      <h2>{segments.length === 12 ? 'The Twelve Prizes' : 'The Prizes'}</h2>
      {mix.games > 0 && (
        <p>
          A Bonus Game Or The Diamond Cards {sharePercent(mix.games)} Of The Time. Instant Chip Wins{' '}
          {sharePercent(mix.chips)}.
          {mix.items > 0
            ? ` Throwables, Time Banks And Rabbit Hunts ${sharePercent(mix.items)}.`
            : ''}
        </p>
      )}
      {vip && (
        <p>
          Your VIP Card Pays Throwables, Time Banks And Rabbit Hunts As Instant Chip Wins Instead.
        </p>
      )}
      {mix.games > 0 && <p>Never The Same Prize Twice In A Row.</p>}
      {segments.some((s) => s.kind === 'upgrade') && (
        <p>Land On A Bonus Game To Play. Upgrade Opens Super Games And Instant Chip Wins.</p>
      )}
      <ul>
        {[...segments]
          .sort((a, b) => a.ord - b.ord)
          .map((segment, i) => (
            <li key={segment.ord}>
              <WheelPrizeArt segment={segment} className={styles.prizeArt} />
              <strong>{wheelPrizeTitle(segment)}</strong>
              {segment.kind === 'chips' && segment.multiplier && (
                <span>{segment.multiplier}x Chip Payout</span>
              )}
              {segment.kind === 'bonus' && <span>Bonus Game</span>}
              {segment.kind === 'upgrade' && <span>Super Games And Chip Wins</span>}
              <i aria-hidden="true" style={{ animationDelay: `${i * -0.2}s` }} />
            </li>
          ))}
      </ul>
    </section>
  );
}

export function WheelEntry({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className={styles.entry}>
      <label htmlFor="diamond-spin-entry">Diamonds To Spin</label>
      <input
        id="diamond-spin-entry"
        aria-describedby="diamond-spin-range"
        type="number"
        inputMode="numeric"
        min={25}
        max={2500}
        step={1}
        value={Number.isNaN(value) ? '' : value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
      <span id="diamond-spin-range">25 To 2,500</span>
      <div className={styles.presets}>
        {[25, 100, 500, 1000, 2500].map((amount) => (
          <button
            key={amount}
            type="button"
            disabled={disabled}
            aria-pressed={value === amount}
            onClick={() => onChange(amount)}
          >
            {amount.toLocaleString()}
          </button>
        ))}
      </div>
    </div>
  );
}
