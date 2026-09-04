/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE ERROR BOUNDARY — Graceful crash containment for table components
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Feature 9: Wraps BombPotOverlay, SessionHUD, ConnectionHUD, HandForHandBanner
 * so a crash in one component doesn't take down the entire table view.
 */

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../../utils/errorReporter';

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

    // 2026-09-04: this wraps the live table surfaces, including both multi-table
    // mounts - the highest-value crash site in the product - and reported to a
    // console and an in-memory bus, neither of which survives the tab.
    reportError(error, `TableErrorBoundary.${componentName}`, {
      componentStack: info.componentStack?.slice(0, 2000) || '',
    });

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
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || null;
    }
    return this.props.children;
  }
}

export default TableErrorBoundary;
