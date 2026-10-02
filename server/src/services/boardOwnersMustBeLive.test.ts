/**
 * 2026-10-02 launch blocker: the Spin and SNG boards refused ~11 times a
 * minute each on tournaments_club_id_fkey. spin_bonus_pools.club_id has no
 * foreign key, so the pools seeded for reserved Create Club certification
 * fixtures stayed is_active after their clubs were deleted (or deactivated),
 * and every tick tried to open a board for them. A board is opened only for
 * an owner whose club row exists and is active, and an owner refused on the
 * club foreign key is held out for a back-off instead of once per tick.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOARD_OWNER_GONE_BACKOFF_MS,
  isBoardOwnerGoneRefusal,
  liveBoardOwners,
} from './TournamentRecurringService.js';

const RECURRING = readFileSync(
  join(process.cwd(), 'src/services/TournamentRecurringService.ts'),
  'utf8'
);

function methodSource(name: string): string {
  const start = RECURRING.indexOf(`private async ${name}`);
  expect(start).toBeGreaterThan(-1);
  const rest = RECURRING.slice(start);
  const end = rest.indexOf('private async', 'private async'.length);
  return end === -1 ? rest : rest.slice(0, end);
}

const DSS = { clubId: '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3' };
const MIDWAY = { clubId: 'fade0000-0000-0000-0000-000000000001' };
const DELETED_FIXTURE = { clubId: 'd1cd0351-4269-4e0a-839e-1ca6ce4c0cc7' };
const RETIRED_FIXTURE = { clubId: 'd382ba50-46ee-45ee-b3fa-6bc4a73b28d6' };

describe('a board opens only for an owner whose club is live', () => {
  const active = new Set([DSS.clubId, MIDWAY.clubId]);

  it('drops an owner whose club row is gone or inactive, keeps the live ones', () => {
    expect(liveBoardOwners([DSS, DELETED_FIXTURE, MIDWAY, RETIRED_FIXTURE], active)).toEqual([
      DSS,
      MIDWAY,
    ]);
  });

  it('holds out an owner refused on the club foreign key until its back-off expires', () => {
    const now = 1_000_000;
    const gone = new Map([[DSS.clubId, now + BOARD_OWNER_GONE_BACKOFF_MS]]);
    expect(liveBoardOwners([DSS, MIDWAY], active, gone, now)).toEqual([MIDWAY]);
    expect(
      liveBoardOwners([DSS, MIDWAY], active, gone, now + BOARD_OWNER_GONE_BACKOFF_MS + 1)
    ).toEqual([DSS, MIDWAY]);
  });

  it('recognises the refusal a vanished club produces, and nothing else', () => {
    expect(
      isBoardOwnerGoneRefusal(
        'insert or update on table "tournaments" violates foreign key constraint "tournaments_club_id_fkey"'
      )
    ).toBe(true);
    expect(isBoardOwnerGoneRefusal('canceling statement due to statement timeout')).toBe(false);
    expect(isBoardOwnerGoneRefusal(undefined)).toBe(false);
  });

  it('activatedSpinOwners reads the owner clubs and filters through liveBoardOwners', () => {
    const body = methodSource('activatedSpinOwners');
    expect(body).toMatch(/from\('clubs'\)/);
    expect(body).toMatch(/\.eq\('status', 'active'\)/);
    expect(body).toMatch(/liveBoardOwners\(owners, active, this\.boardOwnerGoneUntil\)/);
  });

  it('the atomic creator backs an owner off on the club foreign key and reports it once', () => {
    const body = methodSource('createSeatFirstGameAtomic');
    expect(body).toMatch(/isBoardOwnerGoneRefusal\(error\?\.message\)/);
    expect(body).toMatch(
      /boardOwnerGoneUntil\.set\(ownerClubId, Date\.now\(\) \+ BOARD_OWNER_GONE_BACKOFF_MS\)/
    );
    expect(body).toMatch(/if \(alreadyHeld\) return null;/);
  });
});

/**
 * Same launch audit: SATELLITE_CREATE_ACTIVE_IDENTITY_AMBIGUOUS ~28 per 20
 * minutes. The heads-up satellite board's idempotency read counted the
 * scheduled satellite series into the same target (9 events each for the
 * Deep Stack Society and Midway "Sunday $200 Deep Stack") as duplicates of
 * its own feeder. The board's identity is its unscheduled feeder; a target
 * already fed by a series is satisfied, so the board stands down on it.
 */
describe('the heads-up satellite board stands down for a scheduled series', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      '../supabase/migrations/20261002082303_satellite_board_stands_down_for_a_scheduled_series_and_orpha.sql'
    ),
    'utf8'
  );

  it('counts only unscheduled feeders as the board identity, and still refuses two of them', () => {
    expect(sql).toMatch(
      /count\(\*\) FILTER \(WHERE t\.schedule_id IS NULL\),count\(\*\) INTO v_count,v_fed/
    );
    expect(sql).toMatch(
      /IF v_count>1 THEN RAISE EXCEPTION 'SATELLITE_CREATE_ACTIVE_IDENTITY_AMBIGUOUS'/
    );
  });

  it('returns the board feeder first, else the earliest series feeder, as existing_active', () => {
    expect(sql).toMatch(/IF v_fed>0 THEN/);
    expect(sql).toMatch(
      /ORDER BY \(t\.schedule_id IS NOT NULL\),t\.start_time,t\.id LIMIT 1 FOR UPDATE/
    );
    expect(sql).toMatch(/'outcome','existing_active'/);
  });

  it('is guarded on the live pre-image and retires only orphan certification pools without moving chips', () => {
    expect(sql).toMatch(/r\.h IS DISTINCT FROM 'd624b2a22bb90d7edcad7d318d2e9ee0'/);
    expect(sql).toMatch(/SET is_active=false, deactivated_at=now\(\)/);
    expect(sql).toMatch(/ORPHAN_SPIN_POOL_NOT_A_CERTIFICATION_FIXTURE/);
    expect(sql).not.toMatch(/SET balance|SET\s+is_active=false,\s*balance/);
  });
});
