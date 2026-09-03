import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { useEffect, useRef } from 'react';
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

export function ClubIcon({ name, className }: { name: ClubIconName; className?: string }) {
  const shared = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: join('cb-icon', className),
  };

  const paths: Record<ClubIconName, ReactNode> = {
    spade: (
      <path d="M12 3C9.4 7.2 5 9 5 13a4 4 0 0 0 7 2.7V20H8m4-4.3A4 4 0 0 0 19 13c0-4-4.4-5.8-7-10Z" />
    ),
    diamond: <path d="m12 2 7 7-7 13L5 9l7-7Zm-7 7h14M9 2l3 20 3-20" />,
    bank: (
      <>
        <path d="m3 9 9-6 9 6H3Zm2 10h14M4 22h16M6 9v10m4-10v10m4-10v10m4-10v10" />
      </>
    ),
    wallet: (
      <path d="M4 6.5h14a2 2 0 0 1 2 2v9H4a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h12v4m0 4h5v4h-5a2 2 0 1 1 0-4Z" />
    ),
    treasury: <path d="M4 5h16v15H4V5Zm3 3h10v9H7V8Zm5 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />,
    chat: <path d="M4 4h16v12H9l-5 4V4Zm4 6h.01M12 10h.01M16 10h.01" />,
    stats: <path d="M4 20V10h4v10H4Zm6 0V4h4v16h-4Zm6 0v-7h4v7h-4Z" />,
    timer: <path d="M9 2h6M12 6a8 8 0 1 0 8 8 8 8 0 0 0-8-8Zm0 4v5l3 2" />,
    rabbit: (
      <path d="M8 9 6 2c3 0 5 3 6 6 1-3 3-6 6-6l-2 7m2 3a6 6 0 1 1-12 0c0-3 2.7-5 6-5s6 2 6 5Zm-8 1h.01m4 0h.01M10 16h4" />
    ),
    previous: <path d="M5 5v14m14-13-9 6 9 6V6Z" />,
    menu: <path d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z" />,
    add: <path d="M12 4v16M4 12h16" />,
    settings: (
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4" />
    ),
    sound: <path d="M4 9h4l5-4v14l-5-4H4V9Zm13 1a3 3 0 0 1 0 4m2-7a7 7 0 0 1 0 10" />,
    info: <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-11v6m0-10h.01" />,
  };

  return <svg {...shared}>{paths[name]}</svg>;
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
