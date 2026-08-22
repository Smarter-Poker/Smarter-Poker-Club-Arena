/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BUS TOAST BRIDGE — Connects SHOW_TOAST bus events to the ToastProvider
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Must be rendered INSIDE ToastProvider to have access to useToast().
 * Subscribes to SHOW_TOAST bus events and routes them to the toast UI.
 */

import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useToast, type ToastType } from './Toast';

const SEVERITY_TO_TYPE: Record<string, ToastType> = {
  critical: 'error',
  warning: 'warning',
  info: 'info',
  clock: 'clock',
};

export function BusToastBridge() {
  const { showToast } = useToast();

  useMasterBusSubscription('SHOW_TOAST', (payload: any) => {
    const actualPayload =
      payload && 'severity' in payload
        ? payload
        : (payload as unknown as { severity: string; message: string; durationMs?: number });
    const type = SEVERITY_TO_TYPE[actualPayload.severity] || 'info';
    showToast(actualPayload.message, type, actualPayload.durationMs || 5000);
  });

  return null; // Invisible bridge component
}

export default BusToastBridge;
