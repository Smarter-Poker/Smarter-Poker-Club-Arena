/**
 * IS ONE PLATFORM CAPABILITY OFFERED RIGHT NOW, ACCORDING TO THE DATABASE?
 *
 * The answer comes from `fn_platform_capabilities()` through
 * `readPlatformCapabilities` (src/config/platformCapabilities.ts), never from a
 * constant. This hook is the one way a surface learns it, and it carries no
 * capability of its own: a feature keeps its capability id in its own module.
 *
 * Four outcomes, because "could not ask" is not "off" (CLAUDE.md 10.86):
 *   loading      the read has not answered yet
 *   available    the registry says deployed or production_verified
 *   unavailable  the registry answered and this capability is below deployed
 *                or not in the registry at all, or the caller passed `null`
 *                (a surface with no gated control on screen asks nothing)
 *   unknown      the read failed or was malformed
 * A surface shows a gated control only on `available`; every other outcome
 * hides it.
 *
 * One read is shared by every mounted caller, and a successful answer is kept
 * for a minute, so a screen with ten gated surfaces asks once. A failed read
 * is never kept: the next caller asks again.
 *
 * tests/one-capability-registry.law.test.ts pins this contract.
 */
import { useEffect, useState } from 'react';
import {
  readPlatformCapabilities,
  type PlatformCapabilitiesRead,
  type PlatformCapabilityId,
} from '../config/platformCapabilities';

export type CapabilityGate = 'loading' | 'available' | 'unavailable' | 'unknown';

/** How long a successful read is shared before the next caller asks again. */
export const PLATFORM_CAPABILITY_TTL_MS = 60_000;

let kept: { at: number; read: PlatformCapabilitiesRead } | null = null;
let inFlight: Promise<PlatformCapabilitiesRead> | null = null;

function sharedRead(): Promise<PlatformCapabilitiesRead> {
  if (kept && Date.now() - kept.at < PLATFORM_CAPABILITY_TTL_MS) {
    return Promise.resolve(kept.read);
  }
  if (!inFlight) {
    const request: Promise<PlatformCapabilitiesRead> = readPlatformCapabilities()
      .catch(
        (err: unknown): PlatformCapabilitiesRead => ({
          status: 'unknown',
          reason: err instanceof Error ? err.message : 'read_failed',
        })
      )
      .then((read) => {
        // A reset while this was in flight owns the cache now; do not refill it.
        if (inFlight === request) {
          kept = read.status === 'ok' ? { at: Date.now(), read } : null;
          inFlight = null;
        }
        return read;
      });
    inFlight = request;
  }
  return inFlight;
}

/** The gate one read gives for one id. */
export function gateFrom(read: PlatformCapabilitiesRead, id: PlatformCapabilityId): CapabilityGate {
  if (read.status !== 'ok') return 'unknown';
  return read.capabilities.some((c) => c.id === id && c.available) ? 'available' : 'unavailable';
}

/** Forget the shared read. Tests only. */
export function resetPlatformCapabilityCache(): void {
  kept = null;
  inFlight = null;
}

export function usePlatformCapability(id: PlatformCapabilityId | null): CapabilityGate {
  const [answer, setAnswer] = useState<{ id: PlatformCapabilityId; gate: CapabilityGate } | null>(
    null
  );
  useEffect(() => {
    if (!id) return;
    let live = true;
    void sharedRead().then((read) => {
      if (live) setAnswer({ id, gate: gateFrom(read, id) });
    });
    return () => {
      live = false;
    };
  }, [id]);
  if (!id) return 'unavailable';
  // An answer for another id (the caller switched ids) is not this one's.
  return answer && answer.id === id ? answer.gate : 'loading';
}
