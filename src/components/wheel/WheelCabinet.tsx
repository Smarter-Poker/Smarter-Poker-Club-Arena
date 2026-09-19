import type { ReactNode } from 'react';
import type { DeckBay } from '../console/DeckConsole';
import {
  PlateButton,
  SPADE_CONSOLE_ZONES,
  SPADE_CONSOLE_PLATES_H,
  type PlateButtonProps,
  type ConsoleInk,
} from '../console/SpadeConsole';
import { WheelPrizeArt } from './WheelPrizeArt';
import { wheelPrizeTitle } from './WheelExperience';
import type { WheelSegment } from '../../services/DiamondWheelService';
import styles from './WheelCabinet.module.css';

/** The wheel and its attached controls share one available play viewport. */
export function WheelCabinet({
  title,
  titleId,
  pill,
  pillInk,
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
        <span>Smarter.Poker</span>
        <h1 id={titleId}>{title}</h1>
      </header>
      <div className={styles.wheel}>{children}</div>
      <aside className={styles.controls} aria-label="Diamond Spins Controls">
        <div className={styles.controlHeading}>
          <span className={`sc-ink--${pillInk ?? 'silver'}`} role="status">
            {pill}
          </span>
          {navigation}
        </div>
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
              <PlateButton
                {...secondary}
                zone={SPADE_CONSOLE_ZONES.plateSecondary}
                canvasH={SPADE_CONSOLE_PLATES_H}
              />
            )}
            {primary && (
              <PlateButton
                {...primary}
                zone={SPADE_CONSOLE_ZONES.platePrimary}
                canvasH={SPADE_CONSOLE_PLATES_H}
              />
            )}
          </div>
        </div>
        {notice && <div className={styles.notice}>{notice}</div>}
      </aside>
    </section>
  );
}

export function WheelPrizeGallery({ segments }: { segments: WheelSegment[] }) {
  return (
    <section className={styles.prizes} aria-label="Wheel Prizes">
      <h2>{segments.length === 12 ? 'The Twelve Prizes' : 'The Prizes'}</h2>
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
