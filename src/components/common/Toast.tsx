/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TOAST NOTIFICATION COMPONENT
 * Premium toast notification system with animations
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from 'react';
import { formatPopupText } from '../../utils/popupStyle';
import {
  safeErrorMessage,
  wasSanitized,
  shouldSurfaceError,
  extractRawErrorText,
} from '../../utils/safeErrorMessage';
import { reportError } from '../../utils/errorReporter';
import './Toast.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'clock';

/**
 * How long the SAME popup is barred from returning, whether or not the first
 * one is still on screen. Longer than any retry cycle in the app, so a loop
 * cannot pump one message onto the screen repeatedly.
 */
const TOAST_COOLDOWN_MS = 60_000;

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  onClick?: () => void;
}

export interface ToastContextValue {
  /**
   * 2026-08-22 review: a stable GETTER, not a snapshot array. Nothing in the
   * app reads this (ToastContainer receives the live array via props); it is
   * kept for API compatibility. Making it a getter lets the context value be
   * memoized with a permanently stable identity, so `toast` in a dependency
   * array never re-fires an effect when toasts come and go.
   */
  getToasts: () => Toast[];
  showToast: (message: string, type?: ToastType, duration?: number, onClick?: () => void) => void;
  success: (message: string, duration?: number, onClick?: () => void) => void;
  error: (message: string, duration?: number, onClick?: () => void) => void;
  warning: (message: string, duration?: number, onClick?: () => void) => void;
  info: (message: string, duration?: number, onClick?: () => void) => void;
  clock: (message: string, duration?: number, onClick?: () => void) => void;
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

function ToastInstrumentIcon({ type }: { type: ToastType }) {
  const mark = (() => {
    switch (type) {
      case 'success':
        return <path className="toast__instrument-signal" d="m13.2 20.6 4.3 4.3 9.6-10" />;
      case 'error':
        return (
          <path
            className="toast__instrument-signal toast__instrument-cut"
            d="m14.2 14.2 11.6 11.6M25.8 14.2 14.2 25.8"
          />
        );
      case 'warning':
        return (
          <>
            <path className="toast__instrument-signal" d="m20 11.7 9 16.1H11Z" />
            <path className="toast__instrument-signal" d="M20 17v5.4" />
            <circle className="toast__instrument-lamp" cx="20" cy="25" r="1.1" />
          </>
        );
      case 'clock':
        return (
          <>
            <circle className="toast__instrument-signal" cx="20" cy="20" r="8" />
            <path className="toast__instrument-signal" d="M20 15.2v5.2l3.7 2.2" />
          </>
        );
      case 'info':
        return (
          <>
            <circle className="toast__instrument-signal" cx="20" cy="20" r="8" />
            <path className="toast__instrument-signal" d="M20 18.8v6" />
            <circle className="toast__instrument-lamp" cx="20" cy="15.3" r="1.1" />
          </>
        );
    }
  })();

  return (
    <span className="toast__icon" data-toast-icon={type} aria-hidden="true">
      <svg className="toast__instrument" viewBox="0 0 40 40" focusable="false">
        <path
          className="toast__instrument-frame"
          d="m20 2.5 12.4 5.1 5.1 12.4-5.1 12.4L20 37.5 7.6 32.4 2.5 20 7.6 7.6Z"
        />
        <circle className="toast__instrument-rotor" cx="20" cy="20" r="13.1" />
        <path className="toast__instrument-scan" d="M9.8 27.2 27.2 9.8" />
        <g>{mark}</g>
        <circle
          className="toast__instrument-lamp toast__instrument-status"
          cx="31.2"
          cy="20"
          r="1.25"
        />
      </svg>
    </span>
  );
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

  return (
    <div
      className={`toast toast--${toast.type} ${isExiting ? 'toast--exiting' : ''}${toast.onClick ? ' toast--clickable' : ''}`}
      onClick={() => {
        if (toast.onClick) {
          toast.onClick();
          setIsExiting(true);
          setTimeout(onRemove, 300);
        }
      }}
      style={{ cursor: toast.onClick ? 'pointer' : 'default' }}
    >
      <ToastInstrumentIcon type={toast.type} />
      <span className="toast__message">{toast.message}</span>
      <button
        type="button"
        className="toast__close"
        aria-label="Dismiss Notification"
        onClick={(event) => {
          event.stopPropagation();
          setIsExiting(true);
          setTimeout(onRemove, 300);
        }}
      >
        <span className="toast__close-label">Dismiss</span>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m7 7 10 10M17 7 7 17" />
        </svg>
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
  // Originals already sent to error reporting, with the time they were sent. A retrying
  // caller (heartbeat, poll loop) throws the same error every few seconds; the
  // toast dedupes on screen, so the error reporting report dedupes here to match.
  const reportedRef = useRef<Map<string, number>>(new Map());

  /**
   * When each distinct popup was last shown.
   *
   * Dan 2026-08-21: "it shouldn't just keep popping it up over and over."
   *
   * The dedupe below only ever blocked a TWIN THAT WAS STILL ON SCREEN. A
   * toast lives 4 seconds; a heartbeat, a poll loop or a reconnect retries on
   * a shorter cycle than that gap, so the same message re-fired the moment its
   * predecessor expired. To the player that is one popup that will not go
   * away, which is what the screenshots show. An identical message now cannot
   * come back for a full minute, whether or not the first is still visible.
   */
  const lastShownRef = useRef<Map<string, number>>(new Map());

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', duration = 4000, onClick?: () => void) => {
      // Dan's house rule (2026-08-20), enforced at the ONLY door every toast
      // walks through: Title Case every word, no em dashes. See popupStyle.ts.
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

        /* SILENCE THE INFRASTRUCTURE (Dan, 2026-08-21, with two screenshots).
         "The Table Is Busy" and "Connection Problem" are the retry loop
         talking to itself: the client has already retried, and will retry
         again, so the message is stale before it is read and asks the player
         to do nothing. Dropped here rather than at 392 call sites, and still
         reported, so this is quieter for the player and no quieter for us.
         The disconnection notice Dan wants kept is DisconnectToast, driven by
         the engine's own FSM, and does not come through this door. */
        if (!shouldSurfaceError(original)) {
          const now = Date.now();
          const key = 'silent:' + extractRawErrorText(original);
          const lastSeen = reportedRef.current.get(key);
          if (lastSeen === undefined || now - lastSeen > 30_000) {
            reportedRef.current.set(key, now);
            reportError(new Error(original), 'Toast.error.suppressed', { shownToPlayer: false });
          }
          return;
        }

        text = safeErrorMessage(original);
        if (wasSanitized(original, text)) {
          // The player is spared the detail; error reporting is not. Diagnostics survive.
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

      /* COOLDOWN. See lastShownRef: the on-screen dedupe below cannot stop a
       message that returns after its predecessor expired, which is how one
       error reads as an endless stream of them. */
      const cooldownKey = type + ':' + styled;
      const nowMs = Date.now();
      const shownAt = lastShownRef.current.get(cooldownKey);
      if (shownAt !== undefined && nowMs - shownAt < TOAST_COOLDOWN_MS) return;
      lastShownRef.current.set(cooldownKey, nowMs);
      if (lastShownRef.current.size > 100) {
        for (const [k, t] of lastShownRef.current) {
          if (nowMs - t > TOAST_COOLDOWN_MS) lastShownRef.current.delete(k);
        }
      }

      const id = `toast-${++toastIdRef.current}`;
      setToasts((prev) => {
        // DEDUPE (Dan, same session: "connection lost pop ups need to stop").
        // An identical message already on screen does not stack a twin. The
        // heartbeat loop and its friends retry on intervals, and a column of
        // five matching warnings reads as five separate emergencies.
        if (prev.some((t) => t.message === styled && t.type === type)) return prev;
        const next = [...prev, { id, type, message: styled, duration, onClick }];
        // Cap at 5 visible toasts; dismiss oldest if overflow
        return next.length > 5 ? next.slice(-5) : next;
      });
    },
    []
  );

  const success = useCallback(
    (message: string, duration?: number, onClick?: () => void) =>
      showToast(message, 'success', duration, onClick),
    [showToast]
  );
  const error = useCallback(
    (message: string, duration?: number, onClick?: () => void) =>
      showToast(message, 'error', duration, onClick),
    [showToast]
  );
  const warning = useCallback(
    (message: string, duration?: number, onClick?: () => void) =>
      showToast(message, 'warning', duration, onClick),
    [showToast]
  );
  const info = useCallback(
    (message: string, duration?: number, onClick?: () => void) =>
      showToast(message, 'info', duration, onClick),
    [showToast]
  );
  const clock = useCallback(
    (message: string, duration?: number, onClick?: () => void) =>
      showToast(message, 'clock', duration, onClick),
    [showToast]
  );

  // 2026-08-22: MEMOIZE. This value was a fresh object on every provider
  // render, so every consumer with `toast` in a dependency array re-ran its
  // effect on every toast add/remove. TablePage's 5s heartbeat effect was the
  // casualty: each toast tore the interval down, fired an extra immediate
  // heartbeat, and RESET the consecutive-miss counter. During an outage
  // (when toasts fire most) the "connection lost" warning could never
  // accumulate its three misses. All members are useCallback/state, so this
  // only changes identity stability, not behaviour.
  // Live ref so getToasts always returns current state without destabilising
  // the memoized context value.
  const toastsRef = useRef<Toast[]>(toasts);
  toastsRef.current = toasts;
  const getToasts = useCallback(() => toastsRef.current, []);
  const value: ToastContextValue = useMemo(
    () => ({
      getToasts,
      showToast,
      success,
      error,
      warning,
      info,
      clock,
      removeToast,
    }),
    [getToasts, showToast, success, error, warning, info, clock, removeToast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  );
}

export default ToastProvider;
