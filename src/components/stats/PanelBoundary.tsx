/**
 * PanelBoundary — one broken panel must not take the whole page with it.
 *
 * WHY
 * ---
 * The stats page is wrapped in a single PageErrorBoundary. That is the right
 * last line of defence, but it is far too coarse: on 2026-08-21 the page went
 * to "Something Went Wrong" and the player lost EVERYTHING — hero numbers,
 * tabs, tournaments, hand history — because one panel threw during render.
 *
 * A stats page is a collection of independent readings. If the heatmap cannot
 * render, that is no reason to hide the win rate. Each panel gets its own
 * boundary so a failure costs exactly that panel and says so in place.
 *
 * The error is reported (via PageErrorBoundary's own reporting path, which
 * writes to client_crash_log) rather than swallowed, so a degraded panel is
 * still a visible, diagnosable event and not a silent hole in the page.
 *
 * RECOVERY (2026-09-03). `hasError` used to be permanent for the life of the
 * page: one bad payload for one range killed the panel until a reload, and
 * changing the range - which fetches a different payload - could not bring it
 * back. The boundary now resets when `resetKey` changes (the page passes the
 * range and the user) and offers a Try Again that does the same in place.
 */

import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Shown in the fallback and recorded with the crash. */
  name: string;
  /** When this changes, a failed panel gets another go with the new data. */
  resetKey?: string | number | null;
}

interface State {
  hasError: boolean;
  message: string | null;
  /** Bumped by Try Again so the children remount. */
  attempt: number;
}

export class PanelBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: null, attempt: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, message: error?.message ?? 'unknown' };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`[PanelBoundary] ${this.props.name} failed to render:`, error, errorInfo);
    void this.report(error, errorInfo);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.retry();
    }
  }

  private retry = () => {
    this.setState((s) => ({ hasError: false, message: null, attempt: s.attempt + 1 }));
  };

  private async report(error: Error, errorInfo: React.ErrorInfo): Promise<void> {
    try {
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
        boundary: 'club-arena-panel',
        section: this.props.name,
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
      /* reporting a failure must never itself fail loudly */
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="panel-boundary-fallback" role="alert">
          <strong>{this.props.name}</strong>
          <span>Could Not Be Shown. The Rest Of Your Stats Are Unaffected.</span>
          <button type="button" className="panel-boundary-retry" onClick={this.retry}>
            Try Again
          </button>
        </div>
      );
    }
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}

export default PanelBoundary;
