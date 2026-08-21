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
        <div
          style={{
            padding: '32px 24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
            minHeight: '40vh',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.7)',
          }}
        >
          <span style={{ fontSize: 40, opacity: 0.5 }}>Warning</span>
          <h3
            style={{
              margin: 0,
              fontSize: 18,
              color: 'rgba(255,255,255,0.9)',
              fontWeight: 600,
            }}
          >
            Something Went Wrong
          </h3>
          <p
            style={{
              margin: 0,
              fontSize: 14,
              textAlign: 'center',
              maxWidth: 320,
              lineHeight: 1.5,
            }}
          >
            {this.props.pageName || 'This page'} Encountered An Error.
            <br />
            Try Refreshing Or Go Back.
          </p>

          {/* The actual error, on screen. Without this the fallback is a dead
              end for whoever is looking at it: they can see that something
              broke and have no way to say WHAT, which is exactly how the
              stats-page crash on 2026-08-21 cost an afternoon of guessing.
              One line, monospaced, screenshot-able. */}
          {this.state.error?.message && (
            <code
              style={{
                display: 'block',
                maxWidth: 420,
                padding: '8px 10px',
                borderRadius: 6,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.55)',
                fontSize: 11,
                lineHeight: 1.45,
                textAlign: 'left',
                wordBreak: 'break-word',
                textTransform: 'none',
              }}
            >
              {String(this.state.error.message).slice(0, 300)}
            </code>
          )}
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <button
              onClick={this.handleRetry}
              aria-label="Retry loading page"
              style={{
                padding: '10px 20px',
                borderRadius: 8,
                border: 'none',
                background: 'rgba(59, 130, 246, 0.8)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Try Again
            </button>
            <button
              onClick={() => window.history.back()}
              aria-label="Go back to previous page"
              style={{
                padding: '10px 20px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: 'rgba(255,255,255,0.7)',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Go Back
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default PageErrorBoundary;
