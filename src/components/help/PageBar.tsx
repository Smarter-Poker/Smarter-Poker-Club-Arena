/**
 * PageBar - what a page hero becomes (Dan, 2026-10-17).
 *
 * A hero used to be an eyebrow, a giant title and a paragraph over artwork.
 * Dan: "PAGES DON'T NEED TITLES LIKE THIS... ALL THESE WORDS ARE DISTRACTING".
 *
 * What survives is what a player acts on: the live status, the page's own
 * live figures, and its buttons (children), with the painted "?" in the top
 * right holding the explanation and the tutorial. The title stays in the
 * document for screen readers and the browser outline; nobody sees it.
 */
import type { ReactNode } from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import PageHelp, { type TutorialStep } from './PageHelp';

export interface PageBarMetric {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'live' | 'attention';
}

export interface PageBarProps {
  title: string;
  /** The words the hero used to print. Now they live behind the "?". */
  summary?: string;
  status?: ReactNode;
  metrics?: PageBarMetric[];
  steps?: TutorialStep[];
  /** The page's own controls, kept in the bar beside its live figures. */
  children?: ReactNode;
  className?: string;
  /** The heading level the hidden title uses. A page has one h1. */
  titleAs?: 'h1' | 'h2';
  titleId?: string;
}

export default function PageBar({
  title,
  summary,
  status,
  metrics = [],
  steps,
  children,
  className,
  titleAs: Heading = 'h1',
  titleId,
}: PageBarProps) {
  const hasLive = Boolean(status) || metrics.length > 0 || Boolean(children);
  return (
    <header className={className ? `ca-page-bar ${className}` : 'ca-page-bar'}>
      <Heading className="sr-only" id={titleId}>
        {title}
      </Heading>
      {hasLive && (
        <div className="ca-page-bar__live">
          {status && (
            <span className="ca-page-bar__status" role="status">
              <span aria-hidden="true" />
              {status}
            </span>
          )}
          {metrics.length > 0 && (
            <dl className="ca-page-bar__metrics" aria-label={`${title} Live Summary`}>
              {metrics.map((metric) => (
                <div
                  key={metric.label}
                  className="ca-page-bar__metric"
                  data-tone={metric.tone || 'default'}
                >
                  <dt>{formatPopupText(metric.label)}</dt>
                  <dd>{metric.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {children}
        </div>
      )}
      <PageHelp title={title} summary={summary} steps={steps} />
    </header>
  );
}
