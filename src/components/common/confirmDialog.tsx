/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  confirmDialog — Promise-based imperative confirmation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium, themed replacement for the blocking native `window.confirm()`.
 * A single <ConfirmHost/> is mounted once at the app root (next to the toast
 * bridge). Any code — inside or outside React — can then call:
 *
 *     if (await confirmDialog({ message: 'Delete this?', variant: 'danger' })) { ... }
 *
 * The call resolves `true` when the user confirms and `false` on cancel/escape/
 * backdrop. Concurrent calls are queued so two confirms never stomp each other.
 *
 * Why imperative (vs. per-component modal state): it makes each call site a
 * one-line swap from `confirm(...)`, with no extra state/JSX bolted onto the
 * (often very large) page components.
 */

import { useEffect, useState } from 'react';
import { ConfirmModal } from './ConfirmModal';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
}

interface ConfirmRequest {
  id: number;
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

// Module-level bridge between the imperative API and the mounted host.
let enqueue: ((req: ConfirmRequest) => void) | null = null;
let counter = 0;

/**
 * Show a themed confirmation dialog. Resolves true on confirm, false otherwise.
 * If the host isn't mounted yet (shouldn't happen in-app), resolves false rather
 * than falling back to the native dialog we're intentionally replacing.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) {
      console.warn('[confirmDialog] ConfirmHost not mounted - resolving false');
      resolve(false);
      return;
    }
    enqueue({ id: ++counter, opts, resolve });
  });
}

/**
 * Mount ONCE at the app root. Renders the active confirm and drains the queue.
 */
export function ConfirmHost() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);

  useEffect(() => {
    enqueue = (req: ConfirmRequest) => setQueue((q) => [...q, req]);
    return () => {
      enqueue = null;
    };
  }, []);

  const current = queue[0] || null;

  const settle = (result: boolean) => {
    setQueue((q) => {
      const [head, ...rest] = q;
      if (head) head.resolve(result);
      return rest;
    });
  };

  return (
    <ConfirmModal
      isOpen={!!current}
      title={current?.opts.title}
      message={current?.opts.message || ''}
      confirmText={current?.opts.confirmText}
      cancelText={current?.opts.cancelText}
      variant={current?.opts.variant}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}

export default confirmDialog;
