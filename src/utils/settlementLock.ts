/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTLEMENT LOCK — Standalone utility to check settlement-period chip freeze
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consolidated from World Hub `settlement-lock.js`.
 *
 * During the weekly settlement window (Sunday 11:59 PM → Monday 4 AM PST),
 * chip operations (mint, transfer, distribute) are frozen.
 * This utility provides a quick boolean + metadata check for any page or
 * service that needs to guard chip-write operations.
 */

import { supabase } from '../lib/supabase';
import { resolveClubUUID } from './clubIdResolver';
import { reportError } from './errorReporter';

export interface SettlementLockResult {
  locked: boolean;
  reason?: string;
  unlocksAt?: string;
  message?: string;
}

/**
 * Check if a club is currently in settlement lock (chip-freeze period).
 *
 * Strategy:
 *   1. Resolve clubId to UUID (route params may be integer slugs like "77777").
 *   2. Check `clubs.settlement_locked` column for an explicit (admin-set) lock.
 *   3. Check `settlement_locks` table for an active time-based lock.
 *
 * Returns `{ locked: false }` if the club is free to transact.
 */
export async function checkSettlementLock(clubId: string): Promise<SettlementLockResult> {
  if (!clubId) return { locked: false };

  // CRITICAL: Resolve slug/integer club IDs to UUID before querying.
  // Route params can be "77777" (club_id integer) or a UUID — the clubs.id
  // column is UUID-only, so querying with an integer silently returns no match.
  const resolvedId = await resolveClubUUID(clubId);

  try {
    // 1. Check `clubs` table for an explicit settlement lock flag
    const { data: club } = await supabase
      .from('clubs')
      .select('settlement_locked, settlement_lock_until')
      .eq('id', resolvedId)
      .maybeSingle();

    if (club?.settlement_locked) {
      // If there is a lock-until timestamp, check if it has expired
      if (club.settlement_lock_until) {
        const lockUntil = new Date(club.settlement_lock_until);
        if (lockUntil <= new Date()) {
          // Lock has expired → auto-clear (best-effort, non-blocking)
          supabase
            .from('clubs')
            .update({ settlement_locked: false, settlement_lock_until: null })
            .eq('id', resolvedId)
            .then(() => {
              /* auto-cleared expired lock */
            });
          return { locked: false };
        }

        return {
          locked: true,
          reason: 'Settlement period active',
          unlocksAt: club.settlement_lock_until,
          message: `Club is locked for settlement until ${lockUntil.toLocaleString('en-US', {
            timeZone: 'America/Los_Angeles',
            dateStyle: 'short',
            timeStyle: 'short',
          })} PST. Chip operations are frozen.`,
        };
      }

      return {
        locked: true,
        reason: 'Settlement lock (manual)',
        message:
          'Club is locked for settlement. Chip operations are frozen until an admin unlocks it.',
      };
    }

    // 2. Check `settlement_locks` table for active time-range lock
    const { data: lockRow } = await supabase
      .from('settlement_locks')
      .select('id, lock_start:locked_at, lock_end:unlock_at, reason:lock_reason')
      .eq('club_id', resolvedId)
      .gte('unlock_at', new Date().toISOString())
      .lte('locked_at', new Date().toISOString())
      .order('locked_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lockRow) {
      return {
        locked: true,
        reason: lockRow.reason || 'Settlement window active',
        unlocksAt: lockRow.lock_end,
        message: `Settlement window active until ${new Date(lockRow.lock_end).toLocaleString(
          'en-US',
          {
            timeZone: 'America/Los_Angeles',
            dateStyle: 'short',
            timeStyle: 'short',
          }
        )} PST.`,
      };
    }

    return { locked: false };
  } catch (err: unknown) {
    reportError(err, 'settlementLock.Error_checking_lock');
    // Fail-open: if we can't check the lock, allow the operation
    // (the RPC layer has its own guard — this is advisory only)
    return { locked: false };
  }
}

export default checkSettlementLock;
