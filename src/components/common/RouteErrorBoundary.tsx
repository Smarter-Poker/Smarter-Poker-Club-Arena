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
import { claimChunkErrorForBoundary } from '../../utils/lazyWithRetry';

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

    // Stale chunks after a deploy: one shared, build-keyed guarded hard
    // reload (utils/lazyWithRetry), the same recovery every boundary uses.
    claimChunkErrorForBoundary(error);
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
          description="Reload The Latest Poker Arena Assets, Or Return To The Previous Page. Your Navigation Shell And Active Session Remain Available."
          action={{ label: 'Reload Page', onClick: this.handleReload }}
          secondaryAction={{ label: 'Go Back', onClick: () => window.history.back() }}
        />
      );
    }

    return this.props.children;
  }
}
