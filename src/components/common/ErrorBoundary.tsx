/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ERROR BOUNDARY — Sentry-Enhanced Error Handling
 * ═══════════════════════════════════════════════════════════════════════════════
 * Catches React rendering errors and reports them to Sentry with full context.
 * Provides user feedback dialog for error reporting.
 *
 * Uses lazy-loaded Sentry via dynamic import — no static @sentry/react import,
 * keeping the error boundary out of the critical bundle path.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Component, ErrorInfo, ReactNode } from 'react';
import { getSentryAsync } from '../../core/SentryInit';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  eventId: string | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      eventId: null,
    };
  }

  static getDerivedStateFromError(_: Error): State {
    return { hasError: true, eventId: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);

    // Auto-reload on stale chunk errors (happens after new deployments)
    if (
      error.message?.includes('dynamically imported module') ||
      error.message?.includes('Failed to fetch') ||
      error.message?.includes('ChunkLoadError') ||
      error.message?.includes('Importing a module script failed') ||
      error.message?.includes('error loading dynamically imported module') ||
      error.message?.includes('Unable to preload CSS') ||
      error.name === 'ChunkLoadError'
    ) {
      console.warn('[ErrorBoundary] Stale chunk detected, reloading...');
      // Dan 2026-08-19: reloading alone re-serves the same stale index.html
      // (SW / bfcache / edge), so the app loops on the identical chunk 404.
      // Purge the SW + caches and navigate cache-busted, once per session.
      try {
        const KEY = 'ca-chunk-hardreload';
        if (!sessionStorage.getItem(KEY)) {
          sessionStorage.setItem(KEY, '1');
          void (async () => {
            try {
              if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
              }
              if (typeof caches !== 'undefined') {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
              }
            } catch {
              /* best effort */
            }
            const url = new URL(window.location.href);
            url.searchParams.set('_cb', String(Date.now()));
            window.location.replace(url.toString());
          })();
        }
      } catch {
        window.location.reload();
      }
      return;
    }

    // Capture exception with Sentry (lazy-loaded) and get event ID
    getSentryAsync()
      .then((Sentry) => {
        if (!Sentry) return;
        Sentry.withScope((scope) => {
          scope.setContext('react', {
            componentStack: errorInfo.componentStack,
          });

          const eventId = Sentry.captureException(error);
          this.setState({ eventId });
        });
      })
      .catch(() => {
        /* Sentry unavailable */
      });
  }

  handleReportClick = () => {
    if (!this.state.eventId) return;
    const eventId = this.state.eventId;
    getSentryAsync()
      .then((Sentry) => {
        if (!Sentry) return;
        Sentry.showReportDialog({
          eventId,
          title: 'Help Us Fix This Issue',
          subtitle: 'Tell Us What Happened',
          subtitle2: 'Your feedback helps us improve Club Arena',
        });
      })
      .catch(() => {
        /* Sentry unavailable */
      });
  };

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
                We've Been Notified And Are Working On A Fix. You Can Help Us By Providing More
                Details About What Happened.
              </p>

              <div
                style={{
                  display: 'flex',
                  gap: '1rem',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                }}
              >
                {this.state.eventId && (
                  <button
                    onClick={this.handleReportClick}
                    style={{
                      padding: '0.75rem 1.5rem',
                      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      fontSize: '1rem',
                      fontWeight: '500',
                      cursor: 'pointer',
                      transition: 'transform 0.2s',
                    }}
                  >
                    Report Feedback
                  </button>
                )}

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

              {this.state.eventId && (
                <p
                  style={{
                    marginTop: '2rem',
                    fontSize: '0.875rem',
                    color: 'rgba(255, 255, 255, 0.5)',
                  }}
                >
                  Error ID: {this.state.eventId}
                </p>
              )}
            </div>
          </div>
        )
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
