import type { ReactNode } from 'react';
import './CashierWorkspace.css';

/** Routed cashier layout. Money dialogs retain their separate painted masters. */
export function CashierWorkspace({
  eyebrow,
  title,
  subtitle,
  pill,
  pillInk,
  className,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  pill?: string;
  pillInk?: string;
  foot?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`cashier-workspace ${className || ''}`} data-cashier-layout="directory">
      <header className="cashier-workspace__header">
        <img
          className="cashier-workspace__art"
          src={`${import.meta.env.BASE_URL}images/cashier/cashier-vault-hero-v1.webp`}
          alt=""
        />
        <div>
          <span className="cashier-workspace__eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {pill && (
          <span className={`cashier-workspace__status sc-ink--${pillInk || 'blue'}`} role="status">
            {pill}
          </span>
        )}
      </header>
      <div className="cashier-workspace__content">{children}</div>
    </div>
  );
}
