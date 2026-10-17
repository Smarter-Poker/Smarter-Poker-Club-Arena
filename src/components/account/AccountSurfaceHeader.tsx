import type { ReactNode } from 'react';
import PageBar from '../help/PageBar';

interface AccountSurfaceHeaderProps {
  title: string;
  /** What the page is for. Shown behind the "?" in the top right, never on the page. */
  description: string;
  status?: string;
  children?: ReactNode;
}

/**
 * The top of the player-account surfaces (Notifications, Settings).
 *
 * Dan, 2026-10-17: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL
 * DESCRIPTIONS". The eyebrow, the giant title, the paragraph and the hero
 * artwork are gone. What is left is the live status and the page's figures,
 * with the explanation and the tutorial behind the painted "?".
 */
export default function AccountSurfaceHeader({
  title,
  description,
  status,
  children,
}: AccountSurfaceHeaderProps) {
  return (
    <PageBar title={title} summary={description} status={status}>
      {children}
    </PageBar>
  );
}
