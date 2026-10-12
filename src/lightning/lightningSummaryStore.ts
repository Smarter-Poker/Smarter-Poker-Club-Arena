/**
 * LIGHTNING PHASE 8: which Lightning session's summary is on screen.
 *
 * The room that is left unmounts as the player lands in the lobby, so the
 * request to show the summary is handed here and drawn by the app-root host
 * (LightningSessionSummaryHost), the same pattern as the cash Session
 * Complete card. One summary at a time; a new one replaces the last.
 */
import { useSyncExternalStore } from 'react';

export interface LightningSummaryRequest {
  poolSessionId: string;
  clusterId: string;
  /** The Cluster's name for the header, when known. */
  name: string | null;
}

let current: LightningSummaryRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function openLightningSessionSummary(req: LightningSummaryRequest): void {
  if (!req.poolSessionId || !req.clusterId) return;
  current = { ...req };
  emit();
}

export function closeLightningSessionSummary(): void {
  if (!current) return;
  current = null;
  emit();
}

export function peekLightningSessionSummary(): LightningSummaryRequest | null {
  return current;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useLightningSummaryRequest(): LightningSummaryRequest | null {
  return useSyncExternalStore(subscribe, peekLightningSessionSummary, peekLightningSessionSummary);
}
