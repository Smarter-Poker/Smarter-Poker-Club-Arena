/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE INSTALL, ONE ID: the device signal the multi-account detector reads
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-22: the multi-account detector must "truly only flag multiple
 * accounts, not multiple log ins". An IP address cannot tell two people in one
 * house from one person with two accounts, and iCloud Private Relay or a VPN
 * hides it entirely. The same browser or app install signing into two
 * accounts can.
 *
 * This keeps one random id per install (localStorage, which the native
 * WebView persists too) and reports it once per signed-in session through
 * `ca_record_device_sighting`. The database reads the address and user agent
 * from the request itself; the client sends nothing but the id, so nothing
 * here can be used to frame another player.
 *
 * Never throws, never blocks rendering, never retries in a loop. A browser
 * that refuses storage still reports an id for the life of the tab.
 */
import { supabase } from './supabase';

export const DEVICE_ID_STORAGE_KEY = 'ca_device_id';
const REPORT_INTERVAL_MS = 30 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let memoryId: string | null = null;
const lastReported = new Map<string, number>();
let started = false;

function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The install's permanent id, created on first use. */
export function getDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (stored && UUID_RE.test(stored)) return stored;
    const id = memoryId ?? newId();
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
    memoryId = id;
    return id;
  } catch {
    if (!memoryId) memoryId = newId();
    return memoryId;
  }
}

/** Report this install for the signed-in user, at most once per 30 minutes. */
export async function reportDeviceSighting(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const now = Date.now();
  const last = lastReported.get(userId) ?? 0;
  if (now - last < REPORT_INTERVAL_MS) return;
  lastReported.set(userId, now);
  try {
    const { error } = await supabase.rpc('ca_record_device_sighting', {
      p_device_id: getDeviceId(),
    });
    if (error) lastReported.set(userId, last);
  } catch {
    lastReported.set(userId, last);
  }
}

/** Wire the report to sign-in and session restore. Idempotent. */
export function startDeviceSighting(): void {
  if (started) return;
  started = true;
  try {
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
        void reportDeviceSighting(session?.user?.id);
      }
    });
  } catch {
    /* auth unavailable: nothing to report */
  }
}

/** Test seam. */
export function __resetDeviceSightingForTests(): void {
  memoryId = null;
  lastReported.clear();
  started = false;
}
