/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TOAST NOTIFICATION COMPONENT
 * Premium toast notification system with animations
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import { safeErrorMessage, wasSanitized } from '../../utils/safeErrorMessage';
import { reportError } from '../../utils/errorReporter';
import './Toast.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

export interface ToastContextValue {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  removeToast: (id: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════════

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOAST ITEM COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

interface ToastItemProps {
  toast: Toast;
  onRemove: () => void;
}

function ToastItem({ toast, onRemove }: ToastItemProps) {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const duration = toast.duration ?? 4000;
    const exitTimer = setTimeout(() => setIsExiting(true), duration - 300);
    const removeTimer = setTimeout(onRemove, duration);

    return () => {
      clearTimeout(exitTimer);
      clearTimeout(removeTimer);
    };
  }, [toast.duration, onRemove]);

  const icons: Record<ToastType, string> = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ',
  };

  return (
    <div className={`toast toast--${toast.type} ${isExiting ? 'toast--exiting' : ''}`}>
      <span className="toast__icon">{icons[toast.type]}</span>
      <span className="toast__message">{toast.message}</span>
      <button
        className="toast__close"
        onClick={() => {
          setIsExiting(true);
          setTimeout(onRemove, 300);
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOAST CONTAINER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function ToastContainer({
  toasts,
  removeToast,
}: {
  toasts: Toast[];
  removeToast: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER
// ═══════════════════════════════════════════════════════════════════════════════

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  // Originals already sent to Sentry, with the time they were sent. A retrying
  // caller (heartbeat, poll loop) throws the same error every few seconds; the
  // toast dedupes on screen, so the Sentry report dedupes here to match.
  const reportedRef = useRef<Map<string, number>>(new Map());

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message: string, type: ToastType = 'info', duration = 4000) => {
    // Dan's house rule (2026-08-20), enforced at the ONLY door every toast
    // walks through: Title Case every word, no em dashes. See popupStyle.ts —
    // a rule in the render path cannot drift, a rule in a doc does.
    //
    // SAME DOOR, SECOND LOCK (Dan, 2026-08-20): "stop allowing server error
    // messages to appear for users." Hundreds of call sites do
    // `toast.error(e?.message || '...')`. Sanitising HERE makes every one of
    // them safe without editing any of them, and no caller can opt out by
    // passing `e.message` straight through. See utils/safeErrorMessage.ts.
    let text = message;
    if (type === 'error') {
      const original = typeof message === 'string' ? message : String(message ?? '');
      text = safeErrorMessage(original);
      if (wasSanitized(original, text)) {
        // The player is spared the detail; Sentry is not. Diagnostics survive.
        const now = Date.now();
        const lastSeen = reportedRef.current.get(original);
        if (lastSeen === undefined || now - lastSeen > 30_000) {
          reportedRef.current.set(original, now);
          if (reportedRef.current.size > 50) {
            for (const [k, t] of reportedRef.current) {
              if (now - t > 30_000) reportedRef.current.delete(k);
            }
          }
          reportError(new Error(original), 'Toast.error.sanitized', { shownToPlayer: text });
        }
      }
    }
    const styled = formatPopupText(text);
    const id = `toast-${++toastIdRef.current}`;
    setToasts((prev) => {
      // DEDUPE (Dan, same session: "connection lost pop ups need to stop").
      // An identical message already on screen does not stack a twin — the
      // heartbeat loop and its friends retry on intervals, and a column of
      // five matching warnings reads as five separate emergencies.
      if (prev.some((t) => t.message === styled && t.type === type)) return prev;
      const next = [...prev, { id, type, message: styled, duration }];
      // Cap at 5 visible toasts — dismiss oldest if overflow
      return next.length > 5 ? next.slice(-5) : next;
    });
  }, []);

  const success = useCallback(
    (message: string, duration?: number) => showToast(message, 'success', duration),
    [showToast]
  );
  const error = useCallback(
    (message: string, duration?: number) => showToast(message, 'error', duration),
    [showToast]
  );
  const warning = useCallback(
    (message: string, duration?: number) => showToast(message, 'warning', duration),
    [showToast]
  );
  const info = useCallback(
    (message: string, duration?: number) => showToast(message, 'info', duration),
    [showToast]
  );

  const value: ToastContextValue = {
    toasts,
    showToast,
    success,
    error,
    warning,
    info,
    removeToast,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  );
}

export default ToastProvider;
