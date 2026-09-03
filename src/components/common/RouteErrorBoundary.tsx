/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ROUTE ERROR BOUNDARY — Per-Route Error Catching
 * ═══════════════════════════════════════════════════════════════════════════════
 * Lightweight error boundary for individual routes. If a page component crashes,
 * only that page shows an error — navigation stays alive so the user can go back.
 * Resets automatically when the URL changes.
 */

import { Component, ReactNode } from 'react';
import { EmptyState } from './EmptyState';

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
      error.message?.includes('Importing a module script failed') ||
      error.message?.includes('error loading dynamically imported module') ||
      error.message?.includes('Unable to preload CSS') ||
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

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    try {
      void (async () => {
        try {
          if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map((registration) => registration.unregister()));
          }
          if (typeof caches !== 'undefined') {
            const keys = await caches.keys();
            await Promise.all(keys.map((key) => caches.delete(key)));
          }
        } catch {
          /* cache recovery is best-effort */
        }
        const url = new URL(window.location.href);
        url.searchParams.set('_cb', String(Date.now()));
        window.location.replace(url.toString());
      })();
    } catch {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <EmptyState
          icon="ROUTE"
          eyebrow="Route Recovery"
          tone="error"
          title="This Page Ran Into An Issue"
          description="Reload The Latest Club Arena Assets, Or Return To The Previous Page. Your Navigation Shell And Active Session Remain Available."
          action={{ label: 'Reload Page', onClick: this.handleReload }}
          secondaryAction={{ label: 'Go Back', onClick: () => window.history.back() }}
        />
      );
    }

    return this.props.children;
  }
}
