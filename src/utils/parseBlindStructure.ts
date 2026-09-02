/**
 * Parse blind_structure from Supabase REST response.
 *
 * Supabase returns JSONB columns as JSON *strings* (not parsed arrays) via
 * the REST / PostgREST API. This utility normalises the value so that every
 * consumer can safely iterate over an array of BlindLevel objects.
 *
 * Usage:
 *   import { parseBlindStructure } from '@/utils/parseBlindStructure';
 *   const blinds = parseBlindStructure(tournament.blind_structure);
 */

import type { BlindLevel } from '../types/database.types';
import { parseJsonCached } from './parseJsonCached';

const DEFAULT_BLIND: BlindLevel = {
  level: 1,
  smallBlind: 25,
  bigBlind: 50,
  ante: 0,
  durationMinutes: 15,
};

/**
 * Normalise a raw blind_structure value (string | array | null | undefined)
 * into a non-empty BlindLevel[].
 */
export function parseBlindStructure(raw: unknown): BlindLevel[] {
  if (Array.isArray(raw) && raw.length > 0) return raw as BlindLevel[];

  /* Parsed once per distinct string rather than once per call. Callers on the
     tournament Detail tab reach this once a SECOND with the same unchanged
     string, because the level memo has to recompute for the clock and carries
     the parse along with it. See parseJsonCached. */
  const parsed = parseJsonCached(raw);
  if (Array.isArray(parsed) && parsed.length > 0) return parsed as BlindLevel[];

  return [DEFAULT_BLIND];
}

/**
 * Same as parseBlindStructure but also normalises payout_structure.
 */
export function parsePayoutStructure(
  raw: unknown
): Array<{ place: number; position: number; percentage: number }> {
  const normalize = (arr: Array<Record<string, unknown>>) =>
    arr.map((p) => ({
      place: (p.place as number) || (p.position as number) || 0,
      position: (p.position as number) || (p.place as number) || 0,
      percentage: (p.percentage as number) || 0,
    }));

  if (Array.isArray(raw) && raw.length > 0) return normalize(raw);

  const parsed = parseJsonCached(raw);
  if (Array.isArray(parsed) && parsed.length > 0) return normalize(parsed);

  return [];
}
