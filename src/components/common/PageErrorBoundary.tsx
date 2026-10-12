/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PageErrorBoundary — Graceful Page-Level Error Handler
 * ═══════════════════════════════════════════════════════════════════════════════
 * Catches React rendering errors and displays a recovery UI instead of
 * a white screen. Wrap individual pages to isolate failures.
 *
 * @example
 * <PageErrorBoundary pageName="Club Dashboard">
 *   <ClubDashboard />
 * </PageErrorBoundary>
 */

import React from 'react';
import { EmptyState } from './EmptyState';

interface PageErrorBoundaryProps {
  children: React.ReactNode;
  pageName?: string;
  fallback?: (context: { error: Error | null; retry: () => void }) => React.ReactNode;
}

interface PageErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class PageErrorBoundary extends React.Component<
  PageErrorBoundaryProps,
  PageErrorBoundaryState
> {
  constructor(props: PageErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): PageErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(
      `[PageErrorBoundary] ${this.props.pageName || 'Page'} crashed:`,
      error,
      errorInfo.componentStack
    );

    // 2026-08-21: this boundary used to ONLY console.error. So when the player
    // stats page started showing "Something Went Wrong" in production, there
    // was no record of it anywhere - not in client_crash_log, not in error reporting -
    // and the only way to find out what had happened was to ask the person
    // looking at the screen. A boundary that swallows the error and tells
    // nobody is a boundary that turns a five-minute fix into an afternoon.
    //
    // Fire-and-forget, never awaited, and every failure path is swallowed:
    // crash reporting must not be able to cause a crash.
    void this.report(error, errorInfo);
  }

  private async report(error: Error, errorInfo: React.ErrorInfo): Promise<void> {
    // Through the server sink a browser is allowed to use; a direct insert
    // into client_crash_log is refused for every browser role (see
    // utils/reportClientCrash).
    try {
      const { reportClientCrash } = await import('../../utils/reportClientCrash');
      await reportClientCrash({
        section: `club-arena-page:${this.props.pageName || 'Page'}`,
        error,
        componentStack: errorInfo?.componentStack ?? null,
      });
    } catch {
      /* reporting a crash must never itself throw */
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback({ error: this.state.error, retry: this.handleRetry });
      }
      return (
        <EmptyState
          icon="FAULT"
          eyebrow="Page Recovery"
          tone="error"
          title={`${this.props.pageName || 'This Page'} Could Not Render`}
          description="The Failure Was Recorded. Retry This Surface, Or Return To The Previous Page Without Losing The Rest Of Your Poker Arena Session."
          action={{ label: 'Try Again', onClick: this.handleRetry }}
          secondaryAction={{ label: 'Go Back', onClick: () => window.history.back() }}
        >
          {this.state.error?.message && (
            <details>
              <summary>Technical Details</summary>
              <code>{String(this.state.error.message).slice(0, 300)}</code>
            </details>
          )}
        </EmptyState>
      );
    }

    return this.props.children;
  }
}

export default PageErrorBoundary;
