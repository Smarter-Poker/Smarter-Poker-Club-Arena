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
