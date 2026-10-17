import type { ReactNode } from 'react';
import PageBar from '../help/PageBar';
import './CashierWorkspace.css';

/**
 * Routed cashier layout. Money dialogs retain their separate painted masters.
 *
 * Dan, 2026-10-17: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL
 * DESCRIPTIONS". The eyebrow, the giant "Cashier" and the vault artwork are
 * gone. What the page is for lives behind the painted "?"; the club whose
 * wallet this is, and a locked or manual cashier, still print, because a
 * player moving chips must always see which wallet and whether it is open.
 */
export function CashierWorkspace({
  compact = false,
  title,
  summary,
  context,
  pill,
  pillTone,
  className,
  children,
}: {
  compact?: boolean;
  title: string;
  /** What this desk is for. Shown behind the "?", never on the page. */
  summary: string;
  /** Which club's wallet this is, when the page is about one club. */
  context?: string;
  /** A state the player must see: Locked, Manual, No Club, a statement range. */
  pill?: string;
  pillTone?: 'default' | 'live' | 'attention' | 'danger';
  className?: string;
  children: ReactNode;
}) {
  const status = [context, pill].filter(Boolean).join(' · ') || undefined;
  return (
    <div
      className={`cashier-workspace ${compact ? 'cashier-workspace--compact' : ''} ${className || ''}`}
      data-cashier-layout="directory"
    >
      <PageBar title={title} summary={summary} status={status} statusTone={pillTone} />
      <div className="cashier-workspace__content">{children}</div>
    </div>
  );
}
