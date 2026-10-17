/**
 * THE WALLET DESK (Dan 2026-10-16): "When you click the union bank wallet,
 * promo wallet or diamond wallet, they should look feel and function like
 * this cashier functionality. Remove the bulky generic frames that exist on
 * the other pages and make them look and feel like this one."
 *
 * The routed Cashier (src/pages/CashierTradePage.tsx) is the reference: the
 * CashierWorkspace heading, the identity row (art, name, a line under it, a
 * white word on the right), a directory of hairline rows, and the painted
 * action dock pinned to the bottom with its centred selection line. This
 * shell prints exactly that, full screen, for a wallet opened from a lobby.
 * It owns no money logic: every send, pull and ledger read stays in the
 * component that renders it.
 */
import type { ReactNode } from 'react';
import { CashierWorkspace } from './CashierWorkspace';
import './WalletDesk.css';

export interface WalletDeskAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** The full sentence a screen reader hears; the visible word stays short. */
  'aria-label'?: string;
  /** The lit action (the dock's blue word, like the Cashier's Claim Back). */
  lit?: boolean;
  pressed?: boolean;
}

export function WalletDesk({
  ariaLabel,
  art,
  name,
  line,
  onClose,
  closeDisabled,
  dockLine,
  actions,
  sheet,
  children,
}: {
  ariaLabel: string;
  /** The owner's logo (the club's, the union's) or the wallet's art; none prints no image. */
  art?: string | null;
  name: string;
  line: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  dockLine?: ReactNode;
  actions?: WalletDeskAction[];
  /** A sheet over the desk (the amount sheet). Printed outside the workspace,
      whose inline-size containment would otherwise trap a fixed overlay. */
  sheet?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="wdesk"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      /* The desk is the routed Cashier's layout, not a popup: the metallic
         popup chassis must not paint its buttons (metallic-popups.css). */
      data-popup-chassis="none"
    >
      <div className="wdesk__scroll">
        <CashierWorkspace
          compact
          eyebrow="Secure Cashier"
          title="Cashier"
          className="wdesk__workspace"
        >
          <div className="wdesk__glass">
            <div className="wdesk__header">
              <div className="wdesk__identity">
                {art ? <img className="wdesk__art" src={art} alt="" /> : null}
                <span className="wdesk__identityText">
                  <span className="wdesk__name">{name}</span>
                  <span className="wdesk__line">{line}</span>
                </span>
              </div>
              <button
                type="button"
                className="wdesk__close"
                onClick={onClose}
                disabled={closeDisabled}
                aria-label="Close"
              >
                Close
              </button>
            </div>
            {children}
          </div>
        </CashierWorkspace>
      </div>
      {actions && actions.length > 0 && (
        <div className="wdesk__dock">
          <div className="wdesk__dockFrame">
            <div className="wdesk__dockLine" aria-live="polite">
              {dockLine}
            </div>
            <div
              className="wdesk__dockActions"
              style={{ gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))` }}
            >
              {actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className={`wdesk__action ${a.lit ? 'wdesk__action--lit' : ''}`}
                  onClick={a.onClick}
                  disabled={a.disabled}
                  aria-label={a['aria-label']}
                  aria-pressed={a.pressed}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {sheet}
    </div>
  );
}

/** One directory row, printed like a Cashier roster row. */
export function WalletDeskRow({
  name,
  sub,
  figure,
  tag,
  selected,
  disabled,
  onSelect,
  title,
  ariaLabel,
}: {
  name: string;
  sub?: ReactNode;
  figure?: ReactNode;
  tag?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
  ariaLabel?: string;
}) {
  const interactive = Boolean(onSelect);
  const body = (
    <>
      {interactive && (
        <span className={`wdesk__check ${selected ? 'wdesk__check--on' : ''}`} aria-hidden="true" />
      )}
      <span className="wdesk__rowInfo">
        <span className="wdesk__rowName">{name}</span>
        {sub != null && sub !== '' && <span className="wdesk__rowSub">{sub}</span>}
      </span>
      {figure != null && <span className="wdesk__rowFigure">{figure}</span>}
      {tag != null && <span className="wdesk__rowTag">{tag}</span>}
      {interactive && (
        <span className="wdesk__rowSelect" aria-hidden="true">
          {selected ? 'Selected' : 'Select'}
        </span>
      )}
    </>
  );
  if (!interactive) return <div className="wdesk__row">{body}</div>;
  return (
    <button
      type="button"
      className={`wdesk__row wdesk__row--button ${selected ? 'wdesk__row--on' : ''} ${disabled ? 'wdesk__row--blocked' : ''}`}
      onClick={() => !disabled && onSelect?.()}
      aria-pressed={selected}
      aria-disabled={disabled ? true : undefined}
      title={title}
      aria-label={ariaLabel}
    >
      {body}
    </button>
  );
}

/** "PLAYERS · 522 AVAILABLE" heading. */
export function WalletDeskHeading({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="wdesk__heading">
      <h2 className="wdesk__headingTitle">{title}</h2>
      {meta != null && <span className="wdesk__headingMeta">{meta}</span>}
    </div>
  );
}
