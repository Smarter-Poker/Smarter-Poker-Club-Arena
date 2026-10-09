import React from 'react';
import { useFitText } from '../lobby/game-cards/useFitText';
import './AddOnModal.css';

export function PurchaseText({ children }: { children: string }) {
  const ref = useFitText<HTMLSpanElement>(children, 1, 0.5);
  return (
    <span ref={ref} className="addon-console__fit">
      {children}
    </span>
  );
}

/** The owner's October 9 purchase artwork. The caller owns every transaction. */
export function PurchaseConsole({
  title,
  titleId,
  subtitle,
  status,
  rows,
  secondary,
  primary,
  onClose,
  closeDisabled,
  messages,
  amountControls,
}: {
  title: string;
  titleId: string;
  subtitle: string;
  status: React.ReactNode;
  rows: [React.ReactNode, React.ReactNode, React.ReactNode];
  secondary: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string };
  primary: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string };
  onClose: () => void;
  closeDisabled: boolean;
  messages?: React.ReactNode;
  amountControls?: React.ReactNode;
}) {
  const { label: secondaryLabel, ...secondaryProps } = secondary;
  const { label: primaryLabel, ...primaryProps } = primary;
  return (
    <>
      <div className={`addon-console__canvas${amountControls ? ' purchase-console__cash' : ''}`}>
        <img
          className="addon-console__art"
          src={
            amountControls
              ? `${import.meta.env.BASE_URL}assets/club-buttons/popups/cash-purchase-v2/chassis.png`
              : `${import.meta.env.BASE_URL}assets/club-buttons/popups/add-on-v2/chassis.png`
          }
          alt=""
          aria-hidden="true"
        />
        <h2 id={titleId} tabIndex={-1} className="addon-console__title">
          <PurchaseText>{title}</PurchaseText>
        </h2>
        <p className="addon-console__subtitle">
          <PurchaseText>{subtitle}</PurchaseText>
        </p>
        <div className="addon-console__timer">{status}</div>
        <div className="addon-console__row addon-console__row--cost">{rows[0]}</div>
        <div className="addon-console__row addon-console__row--chips">{rows[1]}</div>
        <div className="addon-console__row addon-console__row--balance">{rows[2]}</div>
        {amountControls && (
          <div className="purchase-console__presets" role="group" aria-label="Quick Amounts">
            {amountControls}
          </div>
        )}
        <button
          type="button"
          className="addon-console__plate addon-console__plate--secondary"
          {...secondaryProps}
        >
          <PurchaseText>{secondaryLabel}</PurchaseText>
        </button>
        <button
          type="button"
          className="addon-console__plate addon-console__plate--primary"
          {...primaryProps}
        >
          <PurchaseText>{primaryLabel}</PurchaseText>
        </button>
        <button
          type="button"
          className="addon-console__close"
          aria-label="Close Purchase"
          onClick={onClose}
          disabled={closeDisabled}
        />
      </div>
      {/* Only a caller with something to say below the art gets the slot; the
          table cashier prints inside its frame and passes nothing. */}
      {messages !== undefined && (
        <div className="addon-console__messages" aria-live="polite">
          {messages}
        </div>
      )}
    </>
  );
}
