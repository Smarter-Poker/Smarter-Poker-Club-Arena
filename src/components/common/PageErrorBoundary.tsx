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
import { reportError } from '../../utils/errorReporter';

interface PageErrorBoundaryProps {
  children: React.ReactNode;
  pageName?: string;
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
    // was no record of it anywhere - not in client_crash_log, not in Sentry -
    // and the only way to find out what had happened was to ask the person
    // looking at the screen. A boundary that swallows the error and tells
    // nobody is a boundary that turns a five-minute fix into an afternoon.
    //
    // Fire-and-forget, never awaited, and every failure path is swallowed:
    // crash reporting must not be able to cause a crash.
    // 2026-09-04: the Supabase insert below was only half the fix. The comment
    // above says the crash was recorded 'not in client_crash_log, not in Sentry'
    // and then only client_crash_log was added. Because this boundary is INNER,
    // it stops propagation, so the root boundary never sees these and Sentry
    // heard nothing from 115 of 133 routes. Both destinations now, and the
    // Sentry one first because report() can fail silently on an RLS denial.
    reportError(error, `PageErrorBoundary.${this.props.pageName || 'Page'}`, {
      componentStack: errorInfo.componentStack?.slice(0, 2000) || '',
    });

    void this.report(error, errorInfo);
  }

  private async report(error: Error, errorInfo: React.ErrorInfo): Promise<void> {
    try {
      // Imported lazily so the Supabase client is not pulled into the boundary's
      // module graph, and so a failure to even load it cannot break the
      // fallback UI.
      const { supabase } = await import('../../lib/supabase');
      const { readLocalSession } = await import('../../lib/authUtils');
      // readLocalSession is the canonical auth read here: it is synchronous
      // and uses the token already in localStorage, so attributing a crash
      // never costs a network round trip at the exact moment something is
      // already going wrong. The raw auth-fetch helper is banned by the
      // pre-push guard for precisely this reason.
      let userId: string | null = null;
      try {
        userId = readLocalSession()?.userId ?? null;
      } catch {
        /* an anonymous crash is still worth recording */
      }

      await supabase.from('client_crash_log').insert({
        boundary: 'club-arena-page',
        section: this.props.pageName || 'Page',
        route: typeof window !== 'undefined' ? window.location.pathname : null,
        url: typeof window !== 'undefined' ? window.location.href : null,
        error_name: error?.name ?? 'Error',
        message: String(error?.message ?? error ?? 'unknown'),
        stack: error?.stack ? String(error.stack).slice(0, 8000) : null,
        component_stack: errorInfo?.componentStack
          ? String(errorInfo.componentStack).slice(0, 8000)
          : null,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        user_id: userId,
        embedded: typeof window !== 'undefined' ? window.self !== window.top : null,
        build_sha:
          (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BUILD_SHA ?? null,
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
      return (
        <EmptyState
          icon="FAULT"
          eyebrow="Page Recovery"
          tone="error"
          title={`${this.props.pageName || 'This Page'} Could Not Render`}
          description="The Failure Was Recorded. Retry This Surface, Or Return To The Previous Page Without Losing The Rest Of Your Club Arena Session."
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
