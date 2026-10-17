import type { ReactNode } from 'react';
import PageBar from '../help/PageBar';

export interface CommunityMetric {
  label: string;
  value: number | string;
  tone?: 'default' | 'live' | 'attention';
}

interface CommunitySurfaceHeaderProps {
  title: string;
  /** What the page is for. Shown behind the "?" in the top right, never on the page. */
  description: string;
  metrics?: CommunityMetric[];
  actions?: ReactNode;
}

/**
 * The top of the Community pages (Friends, Search).
 *
 * Dan, 2026-10-17: "PAGES DON'T NEED TITLES LIKE THIS... REMOVE ALL
 * DESCRIPTIONS". The eyebrow, the giant title, the paragraph and the network
 * artwork are gone; the live counts and the page's own buttons stay, with the
 * explanation and the tutorial behind the painted "?".
 */
export default function CommunitySurfaceHeader({
  title,
  description,
  metrics = [],
  actions,
}: CommunitySurfaceHeaderProps) {
  return (
    <PageBar title={title} summary={description} metrics={metrics}>
      {actions}
    </PageBar>
  );
}
