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
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || null;
    }
    return this.props.children;
  }
}

export default TableErrorBoundary;
