import { Component, ErrorInfo, ReactNode } from 'react';
import { reportError } from '../../utils/errorReporter';
import { claimChunkErrorForBoundary, reportExhaustedChunkLoad } from '../../utils/lazyWithRetry';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
    };
  }

  static getDerivedStateFromError(_: Error): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Stale chunks after a deploy: one shared, build-keyed guarded hard
    // reload (utils/lazyWithRetry). A recovered chunk is not an error report.
    const chunk = claimChunkErrorForBoundary(error);
    if (chunk === 'recovering') {
      console.warn('[ErrorBoundary] Stale chunk detected, reloading...');
      return;
    }
    if (chunk === 'exhausted') {
      reportExhaustedChunkLoad(error, 'ErrorBoundary');
      return;
    }
    reportError(error, 'ErrorBoundary', { componentStack: errorInfo.componentStack });
  }

  render() {
    if (this.state.hasError) {
      // Custom fallback UI
      return (
        this.props.fallback || (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '100vh',
              padding: '2rem',
              background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
              color: '#fff',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            <div
              style={{
                maxWidth: '500px',
                textAlign: 'center',
                background: 'rgba(255, 255, 255, 0.05)',
                padding: '3rem',
                borderRadius: '16px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              <div
                style={{
                  fontSize: '4rem',
                  marginBottom: '1rem',
                }}
              >
                Warning
              </div>

              <h1
                style={{
                  fontSize: '1.5rem',
                  marginBottom: '1rem',
                  fontWeight: '600',
                }}
              >
                Something Went Wrong
              </h1>

              <p
                style={{
                  color: 'rgba(255, 255, 255, 0.7)',
                  marginBottom: '2rem',
                  lineHeight: '1.6',
                }}
              >
                Please Reload The Page. If The Problem Continues, Contact Support And Describe What
                Happened.
              </p>

              <div
                style={{
                  display: 'flex',
                  gap: '1rem',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <button
                  onClick={() => window.location.reload()}
                  style={{
                    padding: '0.75rem 1.5rem',
                    background: 'rgba(255, 255, 255, 0.1)',
                    color: '#fff',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontWeight: '500',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  Reload Page
                </button>
              </div>
            </div>
          </div>
        )
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
