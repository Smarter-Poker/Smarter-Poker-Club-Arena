/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  #SMARTERCASINOREALISM - THE DIAMOND GAMES CHASSIS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-08: every build follows #SmarterCasinoRealism; every button,
 * frame and icon carries the premium, high-definition, dynamic look of the
 * rest of the Club Arena. These components are that look, and nothing else:
 * the approved shark-panel-v1 artwork (the lobby's riveted gunmetal rails, its
 * bay plaques, its lit JOIN face and dark VIEW face) wrapped so the Diamond
 * Wheel, Plinko and Crash pages, their lobby and their operator consoles all
 * draw from one set of materials. No page in src/pages/ invents a frame.
 *
 * Nothing here knows about money. See CasinoChassis.module.css for the rules
 * the material obeys (no :hover, motion collapses but meaning never does).
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './CasinoChassis.module.css';

const join = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export function CasinoFrame({
  eyebrow,
  title,
  children,
  className,
  tight = false,
  as: Tag = 'section',
}: {
  eyebrow?: string;
  title?: string;
  children: ReactNode;
  className?: string;
  tight?: boolean;
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <div className={join(styles.frameWrap, className)}>
      <Tag className={join(styles.frame, tight && styles.frameTight)}>
        {eyebrow || title ? (
          <header className={styles.frameHead}>
            {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : null}
            {title ? <h2 className={styles.title}>{title}</h2> : null}
          </header>
        ) : null}
        {children}
      </Tag>
    </div>
  );
}

export type CasinoTone = 'chrome' | 'gold' | 'green' | 'cyan' | 'red';

export function CasinoBays({
  children,
  columns = 2,
  className,
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  return (
    <div
      className={join(
        styles.bays,
        columns === 3 && styles.bays3,
        columns === 4 && styles.bays4,
        className
      )}
    >
      {children}
    </div>
  );
}

export function CasinoBay({
  label,
  value,
  sub,
  tone = 'chrome',
  selected = false,
  locked = false,
  small = false,
  onClick,
  disabled,
  ariaLabel,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: CasinoTone;
  selected?: boolean;
  locked?: boolean;
  small?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const cls = join(
    styles.bay,
    onClick && styles.bayButton,
    selected && styles.baySelected,
    locked && styles.bayLocked,
    tone === 'gold' && styles.bayGold,
    tone === 'green' && styles.bayGreen,
    tone === 'cyan' && styles.bayCyan,
    tone === 'red' && styles.bayRed
  );
  const body = (
    <>
      <span className={styles.bayLabel}>{label}</span>
      <span className={join(styles.bayValue, small && styles.bayValueSmall)}>{value}</span>
      <span className={styles.baySub}>{sub ?? ''}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        onClick={onClick}
        disabled={disabled}
        aria-pressed={selected}
        aria-label={ariaLabel}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={cls} aria-label={ariaLabel}>
      {body}
    </div>
  );
}

export type CasinoButtonTone = 'primary' | 'secondary' | 'gold' | 'danger' | 'green';

export function CasinoButton({
  tone = 'primary',
  sub,
  wide = false,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: CasinoButtonTone;
  sub?: ReactNode;
  wide?: boolean;
}) {
  return (
    <button
      {...rest}
      type={type}
      className={join(
        styles.button,
        tone === 'secondary' && styles.buttonSecondary,
        tone === 'gold' && styles.buttonGold,
        tone === 'danger' && styles.buttonDanger,
        tone === 'green' && styles.buttonGreen,
        wide && styles.buttonWide,
        className
      )}
    >
      <span>{children}</span>
      {sub ? <span className={styles.buttonSub}>{sub}</span> : null}
    </button>
  );
}

export function CasinoButtonRow({ children }: { children: ReactNode }) {
  return <div className={styles.buttonRow}>{children}</div>;
}

export interface CasinoChipItem<T extends string | number> {
  value: T;
  label: string;
  sub?: string;
  disabled?: boolean;
}

export function CasinoChips<T extends string | number>({
  items,
  value,
  onChange,
  label,
}: {
  items: ReadonlyArray<CasinoChipItem<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.chips} role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={String(item.value)}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className={join(styles.chip, item.value === value && styles.chipActive)}
          onClick={() => onChange(item.value)}
          disabled={item.disabled}
        >
          <span>{item.label}</span>
          {item.sub ? <span className={styles.chipSub}>{item.sub}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function CasinoReadout({
  label,
  value,
  tone = 'chrome',
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: 'chrome' | 'gold' | 'red' | 'green';
  className?: string;
}) {
  return (
    <div
      className={join(
        styles.readout,
        tone === 'gold' && styles.readoutGold,
        tone === 'red' && styles.readoutRed,
        tone === 'green' && styles.readoutGreen,
        className
      )}
      role="status"
    >
      <span className={styles.readoutLabel}>{label}</span>
      <span className={styles.readoutValue}>{value}</span>
    </div>
  );
}

export function CasinoWell({
  children,
  lamps = false,
  className,
}: {
  children: ReactNode;
  lamps?: boolean;
  className?: string;
}) {
  return (
    <div className={join(styles.well, lamps && styles.wellLamp, className)}>
      <div className={styles.wellInner}>{children}</div>
    </div>
  );
}

export function CasinoNote({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return <p className={join(styles.note, warn && styles.noteWarn)}>{children}</p>;
}
