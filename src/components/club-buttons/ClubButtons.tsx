import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { useEffect, useId, useRef } from 'react';
import { Mark, type MarkName } from './marks';
import './club-buttons.css';

export type ClubButtonsMode = 'arena' | 'hub' | 'commander';
export type ClubButtonsDataState =
  | 'loading'
  | 'loaded'
  | 'updating'
  | 'empty'
  | 'error'
  | 'stale'
  | 'offline';

export type ClubIconName =
  | 'spade'
  | 'diamond'
  | 'bank'
  | 'wallet'
  | 'treasury'
  | 'chat'
  | 'stats'
  | 'timer'
  | 'rabbit'
  | 'previous'
  | 'menu'
  | 'add'
  | 'settings'
  | 'sound'
  | 'info';

const join = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export interface ClubButtonsSurfaceProps {
  mode?: ClubButtonsMode;
  className?: string;
  children: ReactNode;
}

export function ClubButtonsSurface({
  mode = 'arena',
  className,
  children,
}: ClubButtonsSurfaceProps) {
  return (
    <div className={join('cb-surface', className)} data-club-mode={mode}>
      {children}
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MARKS - icons with facets, not wireframes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-09, on the diamond in the Diamond Games plate: "YOU MUST CREATE
 * AND USE DYNAMIC HIGH QUALITY ICON'S WITH DEPTH AND 3D FEEL, NOT WHAT EVER
 * THIS FLAT BORING BROKEN THING IS."
 *
 * He was right. Every icon on these buttons was a 1.8px `currentColor` stroke
 * on `fill: none` - a wireframe - sitting inside a bevelled steel plate with
 * rivets and a lit LED. At 20px the diamond's three interior facet lines
 * collapsed into a smudge, which is the "broken" he circled.
 *
 * A mark is the other kind: real geometry with a light on it. The gem below is
 * cut the way a brilliant is cut - a table, four crown facets down to the
 * girdle, four pavilion facets converging on the culet - and every facet
 * carries its own gradient. Nothing here is an outline. What makes it read as
 * three dimensions is that neighbouring facets have different VALUES, lit from
 * the top left, exactly as the plate around it is lit.
 *
 * Gradient ids are namespaced per instance (useId): two of these on one page
 * with the same ids would have the second silently steal the first's fills.
 */

interface MarkProps {
  uid: string;
  className: string;
}

/**
 * The stone itself (defs and facets, no <svg>), so the wheel's hub can carry
 * the same cut inside its own drawing. Every id is namespaced by `uid`.
 */
export function DiamondMarkArt({ uid }: { uid: string }) {
  const id = (k: string) => `${uid}-${k}`;
  return (
    <>
      <defs>
        {/* The crown catches the light; the pavilion holds the club's blue. */}
        <linearGradient id={id('cl')} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#a8d8ff" />
        </linearGradient>
        <linearGradient id={id('cm')} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#eaf6ff" />
          <stop offset="1" stopColor="#7cc2f7" />
        </linearGradient>
        <linearGradient id={id('cr')} x1="1" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#9ecdf0" />
          <stop offset="1" stopColor="#3f8fd0" />
        </linearGradient>
        <linearGradient id={id('ce')} x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6ea7d6" />
          <stop offset="1" stopColor="#2b6ea8" />
        </linearGradient>
        <linearGradient id={id('pl')} x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#8fc6ee" />
          <stop offset="1" stopColor="#20527d" />
        </linearGradient>
        <linearGradient id={id('pm')} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="#b6ddf7" />
          <stop offset="1" stopColor="#2f6f9f" />
        </linearGradient>
        <linearGradient id={id('pr')} x1="0.6" y1="0" x2="0.2" y2="1">
          <stop offset="0" stopColor="#5d9bc9" />
          <stop offset="1" stopColor="#153c5e" />
        </linearGradient>
        <linearGradient id={id('pe')} x1="1" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#3d7aa8" />
          <stop offset="1" stopColor="#0d2c47" />
        </linearGradient>
        <linearGradient id={id('gd')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.35" />
        </linearGradient>
        <filter id={id('glow')} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* The stone sits in its own light, the way the LED sits in the plate. */}
      <g filter={`url(#${id('glow')})`}>
        {/* Crown: the table edge at y 11, down to the girdle at y 23. */}
        <path d="M6 23 L22 11 L17 23 Z" fill={`url(#${id('cl')})`} />
        <path d="M17 23 L22 11 L32 11 L32 23 Z" fill={`url(#${id('cm')})`} />
        <path d="M32 23 L32 11 L42 11 L47 23 Z" fill={`url(#${id('cr')})`} />
        <path d="M47 23 L42 11 L58 23 Z" fill={`url(#${id('ce')})`} />
        {/* Pavilion: four facets to the culet. */}
        <path d="M6 23 L19 23 L32 54 Z" fill={`url(#${id('pl')})`} />
        <path d="M19 23 L32 23 L32 54 Z" fill={`url(#${id('pm')})`} />
        <path d="M32 23 L45 23 L32 54 Z" fill={`url(#${id('pr')})`} />
        <path d="M45 23 L58 23 L32 54 Z" fill={`url(#${id('pe')})`} />
        {/* The girdle, and the one specular the whole stone hangs on. */}
        <path d="M6 23 H58" stroke={`url(#${id('gd')})`} strokeWidth="1.7" fill="none" />
        <path d="M20.6 13.4 L29.6 13.4 L23.4 21 Z" fill="#ffffff" opacity="0.55" />
      </g>
    </>
  );
}

function DiamondMark({ uid, className }: MarkProps) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <DiamondMarkArt uid={uid} />
    </svg>
  );
}

/**
 * Every icon is a mark now: the diamond is the cut stone above, the other
 * fourteen are lit objects from one recipe (marks.tsx, marks.json). There is
 * no wireframe left to fall through to.
 */
const MARKS: Partial<Record<ClubIconName, (p: MarkProps) => ReactNode>> = {
  diamond: DiamondMark,
};

/* Every icon name but the diamond must have a mark in marks.json; tsc says so. */
type EveryIconHasAMark = Exclude<ClubIconName, 'diamond'> extends MarkName ? true : never;
const everyIconHasAMark: EveryIconHasAMark = true;
void everyIconHasAMark;

export function ClubIcon({ name, className }: { name: ClubIconName; className?: string }) {
  const uid = useId().replace(/:/g, '');
  const cls = join('cb-icon', 'cb-mark', className);
  const Special = MARKS[name];
  if (Special) return Special({ uid, className: cls });
  return <Mark name={name as MarkName} uid={uid} className={cls} />;
}

export interface ArenaActionButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'value'
> {
  label: string;
  sublabel?: string;
  value?: ReactNode;
  icon?: ClubIconName;
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'compact' | 'regular' | 'large';
  selected?: boolean;
  loading?: boolean;
}

export function ArenaActionButton({
  label,
  sublabel,
  value,
  icon = 'spade',
  variant = 'primary',
  size = 'regular',
  selected = false,
  loading = false,
  className,
  disabled,
  type = 'button',
  ...buttonProps
}: ArenaActionButtonProps) {
  return (
    <button
      {...buttonProps}
      type={type}
      className={join('cb-action', className)}
      data-variant={variant}
      data-size={size}
      data-selected={selected || undefined}
      data-loading={loading || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      <span className="cb-action__icon">
        <ClubIcon name={icon} />
      </span>
      <span className="cb-action__copy">
        <span className="cb-action__label">{label}</span>
        {sublabel && <span className="cb-action__sublabel">{sublabel}</span>}
      </span>
      {value != null && <span className="cb-action__value">{value}</span>}
      <span className="cb-action__indicator" aria-hidden="true">
        {loading ? <span className="cb-spinner" /> : '›'}
      </span>
    </button>
  );
}

export interface ArenaWalletRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'value'
> {
  label: string;
  value?: ReactNode;
  sublabel?: string;
  icon?: ClubIconName;
  dataState?: ClubButtonsDataState;
  valueLabel?: string;
}

export function ArenaWalletRow({
  label,
  value,
  sublabel,
  icon = 'wallet',
  dataState = 'loaded',
  valueLabel,
  className,
  type = 'button',
  ...buttonProps
}: ArenaWalletRowProps) {
  const unavailable = dataState === 'error' || dataState === 'offline' || dataState === 'empty';
  const renderedValue =
    dataState === 'loading'
      ? 'Loading'
      : dataState === 'error'
        ? 'Unavailable'
        : dataState === 'offline'
          ? 'Offline'
          : dataState === 'empty'
            ? 'No Data'
            : value;

  return (
    <button
      {...buttonProps}
      type={type}
      className={join('cb-wallet-row', className)}
      data-state={dataState}
      aria-busy={dataState === 'loading' || dataState === 'updating' || undefined}
    >
      <span className="cb-wallet-row__icon">
        <ClubIcon name={icon} />
      </span>
      <span className="cb-wallet-row__copy">
        <span className="cb-wallet-row__label">{label}</span>
        {sublabel && <span className="cb-wallet-row__sublabel">{sublabel}</span>}
      </span>
      <span
        className="cb-wallet-row__value"
        aria-label={valueLabel}
        data-unavailable={unavailable || undefined}
      >
        {renderedValue}
      </span>
      <span className="cb-wallet-row__indicator" aria-hidden="true">
        {dataState === 'loading' ? <span className="cb-spinner" /> : '›'}
      </span>
    </button>
  );
}

export interface ArenaJackpotDisplayProps {
  value?: ReactNode;
  label?: string;
  eyebrow?: string;
  badge?: string;
  dataState?: ClubButtonsDataState;
  className?: string;
  valueLabel?: string;
}

export function ArenaJackpotDisplay({
  value,
  label = 'Current Jackpot',
  eyebrow = 'Bad Beat Jackpot',
  badge = 'BBJ',
  dataState = 'loaded',
  className,
  valueLabel,
}: ArenaJackpotDisplayProps) {
  const displayValue =
    dataState === 'loading'
      ? 'Loading'
      : dataState === 'error'
        ? 'Unavailable'
        : dataState === 'offline'
          ? 'Offline'
          : dataState === 'empty'
            ? 'No Jackpot Data'
            : value;

  return (
    <section
      className={join('cb-jackpot', className)}
      data-state={dataState}
      aria-busy={dataState === 'loading' || dataState === 'updating' || undefined}
      aria-live="polite"
    >
      <span className="cb-jackpot__badge">{badge}</span>
      <span className="cb-jackpot__eyebrow">{eyebrow}</span>
      <span className="cb-jackpot__value" aria-label={valueLabel}>
        {displayValue}
      </span>
      <span className="cb-jackpot__label">{label}</span>
    </section>
  );
}

export function ArenaValueDisplay({
  value,
  label,
  size = 'medium',
  tone = 'blue',
  className,
}: {
  value: ReactNode;
  label?: string;
  size?: 'small' | 'medium' | 'large';
  tone?: 'blue' | 'gold' | 'green' | 'red';
  className?: string;
}) {
  return (
    <div className={join('cb-value', className)} data-size={size} data-tone={tone}>
      <span className="cb-value__number">{value}</span>
      {label && <span className="cb-value__label">{label}</span>}
    </div>
  );
}

export interface ArenaIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ClubIconName;
  label: string;
  selected?: boolean;
}

export function ArenaIconButton({
  icon,
  label,
  selected,
  className,
  type = 'button',
  ...buttonProps
}: ArenaIconButtonProps) {
  return (
    <button
      {...buttonProps}
      type={type}
      className={join('cb-icon-button', className)}
      data-selected={selected || undefined}
      aria-pressed={selected}
    >
      <ClubIcon name={icon} />
      <span>{label}</span>
    </button>
  );
}

export function ArenaTabs({
  items,
  value,
  onChange,
  label = 'Sections',
}: {
  items: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <div className="cb-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          type="button"
          role="tab"
          key={item.value}
          aria-selected={item.value === value}
          tabIndex={item.value === value ? 0 : -1}
          onClick={() => onChange(item.value)}
          onKeyDown={(event) => {
            if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const current = items.findIndex((candidate) => candidate.value === item.value);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : event.key === 'ArrowRight'
                    ? (current + 1) % items.length
                    : (current - 1 + items.length) % items.length;
            onChange(items[next].value);
            const tablist = event.currentTarget.parentElement;
            window.requestAnimationFrame(() => {
              tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            });
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function ArenaBadge({
  children,
  tone = 'blue',
}: {
  children: ReactNode;
  tone?: 'blue' | 'red' | 'green' | 'gold' | 'purple';
}) {
  return (
    <span className="cb-badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function ArenaPanel({
  title,
  children,
  action,
  className,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={join('cb-panel', className)}>
      {(title || action) && (
        <header className="cb-panel__header">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      <div className="cb-panel__body">{children}</div>
    </section>
  );
}

export function ArenaInput({
  label,
  id,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { label: string; id: string }) {
  return (
    <label className="cb-field" htmlFor={id}>
      <span>{label}</span>
      <input {...props} id={id} />
    </label>
  );
}

export function ArenaSelect({
  label,
  id,
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> & {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <label className="cb-field" htmlFor={id}>
      <span>{label}</span>
      <select {...props} id={id}>
        {children}
      </select>
    </label>
  );
}

export function ArenaToggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="cb-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span className="cb-toggle__track" aria-hidden="true">
        <span />
      </span>
      <span>{label}</span>
    </label>
  );
}

export function ArenaModalFrame({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => returnFocus?.focus();
  }, []);

  return (
    <div
      ref={dialogRef}
      className="cb-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cb-modal-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header>
        <h2 id="cb-modal-title">{title}</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div className="cb-modal__body">{children}</div>
    </div>
  );
}
