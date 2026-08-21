/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ROUTE ERROR BOUNDARY — Per-Route Error Catching
 * ═══════════════════════════════════════════════════════════════════════════════
 * Lightweight error boundary for individual routes. If a page component crashes,
 * only that page shows an error — navigation stays alive so the user can go back.
 * Resets automatically when the URL changes.
 */

import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('[RouteErrorBoundary] Caught:', error.message);

    // Auto-reload on stale chunk errors (after deploys)
    if (
      error.message?.includes('dynamically imported module') ||
      error.message?.includes('Failed to fetch') ||
      error.message?.includes('ChunkLoadError') ||
      error.name === 'ChunkLoadError'
    ) {
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
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '60vh',
            padding: '2rem',
            textAlign: 'center',
            color: '#334155',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠</div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '.5rem' }}>
            This Page Ran Into An Issue
          </h2>
          <p style={{ color: '#64748b', marginBottom: '1.5rem', maxWidth: 400, lineHeight: 1.5 }}>
            Something Unexpected Happened. You Can Go Back Or Try Reloading This Page.
          </p>
          <div style={{ display: 'flex', gap: '.75rem' }}>
            <button
              onClick={() => window.history.back()}
              style={{
                padding: '0.625rem 1.25rem',
                background: '#f1f5f9',
                color: '#334155',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                fontSize: '.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              ← Go Back
            </button>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
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
              }}
              style={{
                padding: '0.625rem 1.25rem',
                background: '#3b82f6',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontSize: '.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
