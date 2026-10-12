/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE ERROR BOUNDARY — Graceful crash containment for table components
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Feature 9: Wraps BombPotOverlay, SessionHUD, ConnectionHUD, HandForHandBanner
 * so a crash in one component doesn't take down the entire table view.
 */

import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  componentName?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class TableErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const componentName = this.props.componentName || 'Component';
    console.error(`[TableErrorBoundary] ${componentName} crashed:`, error, info.componentStack);

    // Enhancement #6: Emit crash event for admin monitoring
    try {
      import('../../core/MasterBus').then(({ masterBus }) => {
        masterBus.emit('COMPONENT_CRASH', {
          componentName,
          error: error.message,
          stack: info.componentStack?.slice(0, 500) || '',
          timestamp: Date.now(),
        });
      });
    } catch (err) {
      console.error('[TableErrorBoundary] Error:', err);
      // Fail silently — crash reporting is best-effort
    }
    // A crash at the live table left no record anyone could act on: the bus
    // event above has one subscriber, an admin page that has to be open at
    // the time (launch audit 2026-10-05). PageErrorBoundary already writes
    // client_crash_log; the boundary around the table now does the same.
    void this.report(error, info);
  }

  private async report(error: Error, info: ErrorInfo): Promise<void> {
    // Through the server sink a browser is allowed to use; a direct insert
    // into client_crash_log is refused for every browser role (see
    // utils/reportClientCrash).
    try {
      const { reportClientCrash } = await import('../../utils/reportClientCrash');
      await reportClientCrash({
        section: `club-arena-table:${this.props.componentName || 'Table'}`,
        error,
        componentStack: info?.componentStack ?? null,
      });
    } catch {
      /* reporting a crash must never itself throw */
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || null;
    }
    return this.props.children;
  }
}

export default TableErrorBoundary;
