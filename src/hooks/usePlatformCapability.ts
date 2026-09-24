/**
 * IS THIS CAPABILITY OFFERED RIGHT NOW? One answer per surface, from the
 * registry's own RPC (src/config/platformCapabilities.ts).
 *
 * `true` only when `fn_platform_capabilities()` just said the capability is
 * available. `false` when it said it is not. `null` while asking, and when the
 * read could not be made at all: "could not tell" is its own answer (CLAUDE.md
 * 10.86), and every caller treats anything but `true` as "do not offer".
 *
 * One read is shared by every mounted caller, and a successful answer is kept
 * for a minute so a sheet opened twice does not ask twice. A failed read is
 * never kept, so the next mount asks again. There is no readiness constant
 * anywhere on the client; this is the only way a surface learns the answer.
 */
import { useEffect, useState } from 'react';
import {
  readPlatformCapabilities,
  type PlatformCapabilitiesRead,
  type PlatformCapabilityId,
} from '../config/platformCapabilities';

const FRESH_MS = 60_000;

let kept: { at: number; read: PlatformCapabilitiesRead } | null = null;
let inFlight: Promise<PlatformCapabilitiesRead> | null = null;

function sharedRead(): Promise<PlatformCapabilitiesRead> {
  if (kept && Date.now() - kept.at < FRESH_MS) return Promise.resolve(kept.read);
  if (!inFlight) {
    inFlight = readPlatformCapabilities()
      .catch(
        (err: unknown): PlatformCapabilitiesRead => ({
          status: 'unknown',
          reason: err instanceof Error ? err.message : 'read_failed',
        })
      )
      .then((read) => {
        kept = read.status === 'ok' ? { at: Date.now(), read } : null;
        return read;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** The answer a read gives for one id: available, not available, or cannot tell. */
export function capabilityAnswer(
  read: PlatformCapabilitiesRead,
  id: PlatformCapabilityId
): boolean | null {
  if (read.status !== 'ok') return null;
  const hit = read.capabilities.find((c) => c.id === id);
  return hit ? hit.available : false;
}

/** Forget the shared answer. Tests only. */
export function resetPlatformCapabilityCache(): void {
  kept = null;
  inFlight = null;
}

/**
 * Pass `null` to ask nothing (a surface with no gated control on screen).
 */
export function usePlatformCapability(id: PlatformCapabilityId | null): boolean | null {
  const [answer, setAnswer] = useState<boolean | null>(null);
  useEffect(() => {
    setAnswer(null);
    if (!id) return;
    let live = true;
    void sharedRead().then((read) => {
      if (live) setAnswer(capabilityAnswer(read, id));
    });
    return () => {
      live = false;
    };
  }, [id]);
  return answer;
}
