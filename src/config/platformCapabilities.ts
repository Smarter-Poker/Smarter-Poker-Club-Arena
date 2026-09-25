/**
 * THE TECHNICAL CAPABILITY REGISTRY, MIRRORED FROM THE DATABASE.
 *
 * `public.platform_capabilities` is authoritative (migration
 * 20260924025555_one_capability_registry_and_accepted_event_continuation.sql).
 * This file mirrors three things a client needs at compile time - the ids, the
 * readiness ladder and what "available" means - and reads everything else,
 * including each capability's CURRENT readiness, from
 * `fn_platform_capabilities()` at run time.
 *
 * A client never offers a capability because a constant here says so. It
 * offers one because the RPC said `available: true` for it just now. There is
 * deliberately no readiness constant per id in this file: a hardcoded
 * readiness is a second source of truth that goes stale the day the database
 * moves.
 *
 * tests/one-capability-registry.law.test.ts pins that these ids equal the
 * migration's seed ids (or, in a tree that does not carry the migration, the
 * JSON copy of its seed block in
 * scripts/ci/fixtures/capability-registry/seeds.json), that variant.ofc is
 * seeded excluded, and that the readiness ladder equals the database CHECK.
 *
 * A surface never calls `readPlatformCapabilities` itself: it asks
 * `usePlatformCapability` (src/hooks/usePlatformCapability.ts), which shares
 * one read of the RPC across the page.
 *
 * Interface contract for the commerce workstream:
 * docs/handoffs/club-arena-product-completion/CAPABILITY-CONTRACT.md
 */
import { supabase } from '../lib/supabase';

/** Every capability id the registry is seeded with, in id order. */
export const PLATFORM_CAPABILITY_IDS = [
  'cash.fixed_limit.kill_pots',
  'cash.insurance_ev_cashout',
  'club.membership_cap',
  'tournament.discovery.trait_filters',
  'tournament.multi_day.multi_flight',
  'tournament.multi_day.single_flight',
  'variant.ofc',
] as const;

export type PlatformCapabilityId = (typeof PLATFORM_CAPABILITY_IDS)[number];

/** The readiness ladder, lowest first. Equal to the database CHECK. */
export const CAPABILITY_READINESS_ORDER = [
  'excluded',
  'planned',
  'implemented',
  'tested',
  'deployed',
  'production_verified',
] as const;

export type CapabilityReadiness = (typeof CAPABILITY_READINESS_ORDER)[number];

export const CAPABILITY_SCOPES = ['platform', 'club', 'union', 'cash_table', 'tournament'] as const;

export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

/** The lowest rung at which a capability may be offered to anyone. */
export const FIRST_AVAILABLE_READINESS: CapabilityReadiness = 'deployed';

export function isCapabilityReadiness(value: unknown): value is CapabilityReadiness {
  return (
    typeof value === 'string' && (CAPABILITY_READINESS_ORDER as readonly string[]).includes(value)
  );
}

export function isPlatformCapabilityId(value: unknown): value is PlatformCapabilityId {
  return (
    typeof value === 'string' && (PLATFORM_CAPABILITY_IDS as readonly string[]).includes(value)
  );
}

/** The same rule as `fn_capability_available`: deployed or production_verified. */
export function isAvailable(readiness: CapabilityReadiness): boolean {
  return (
    CAPABILITY_READINESS_ORDER.indexOf(readiness) >=
    CAPABILITY_READINESS_ORDER.indexOf(FIRST_AVAILABLE_READINESS)
  );
}

export interface PlatformCapability {
  id: PlatformCapabilityId;
  version: string;
  title: string;
  scope: CapabilityScope;
  variants: string[];
  compatibility: Record<string, unknown>;
  readiness: CapabilityReadiness;
  available: boolean;
}

/**
 * The result of one read. `unknown` is its own outcome: a failed or malformed
 * read is never folded into an empty list, because "no capability is
 * available" and "we could not ask" call for different screens.
 */
export type PlatformCapabilitiesRead =
  | { status: 'ok'; capabilities: PlatformCapability[] }
  | { status: 'unknown'; reason: string };

function toCapability(row: unknown): PlatformCapability | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (!isPlatformCapabilityId(r.id) || !isCapabilityReadiness(r.readiness)) return null;
  if (typeof r.version !== 'string' || typeof r.title !== 'string') return null;
  if (typeof r.scope !== 'string' || !(CAPABILITY_SCOPES as readonly string[]).includes(r.scope)) {
    return null;
  }
  const variants = Array.isArray(r.variants)
    ? r.variants.filter((v): v is string => typeof v === 'string')
    : [];
  const compatibility =
    r.compatibility && typeof r.compatibility === 'object' && !Array.isArray(r.compatibility)
      ? (r.compatibility as Record<string, unknown>)
      : {};
  return {
    id: r.id,
    version: r.version,
    title: r.title,
    scope: r.scope as CapabilityScope,
    variants,
    compatibility,
    readiness: r.readiness,
    // Both halves must agree; the client never widens what the server said.
    available: r.available === true && isAvailable(r.readiness),
  };
}

/**
 * Read the public projection. Rows for ids this build does not know are
 * skipped (a newer database may carry capabilities an older bundle cannot
 * offer); anything else malformed makes the whole read `unknown`.
 */
export async function readPlatformCapabilities(): Promise<PlatformCapabilitiesRead> {
  const { data, error } = await supabase.rpc('fn_platform_capabilities');
  if (error) return { status: 'unknown', reason: error.message || 'rpc_error' };
  if (!Array.isArray(data)) return { status: 'unknown', reason: 'malformed_response' };
  const capabilities: PlatformCapability[] = [];
  for (const row of data as unknown[]) {
    const id = row && typeof row === 'object' ? (row as Record<string, unknown>).id : undefined;
    if (typeof id === 'string' && !isPlatformCapabilityId(id)) continue;
    const capability = toCapability(row);
    if (!capability) return { status: 'unknown', reason: 'malformed_row' };
    capabilities.push(capability);
  }
  return { status: 'ok', capabilities };
}
