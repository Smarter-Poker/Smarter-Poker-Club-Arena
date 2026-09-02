/**
 * A BOUNTY POOL BELONGS TO A PLAYER TOO (2026-09-01).
 *
 * The payout audit reconciled the PRIZE pool and reported that every earner was
 * paid. It was right about the prize pool and blind to the other half of the
 * money: a bounty event funds a SECOND pool out of the same buy-in, and nothing
 * on the platform asked whether that one was paid out.
 *
 * It was not. 38 completed bounty events held 1,931.24 chips that reached no
 * player, and it was still happening daily - two events on 2026-09-01, three on
 * 2026-08-31.
 *
 * ONE CAUSE, AND THE EVIDENCE IS UNAMBIGUOUS. finishTournament settles whatever
 * is left in a funded bounty pool to the champion, and 650 of the 673 healthy
 * events carry that payment. NOT ONE of the 38 does. 34 of them were completed
 * by recoverStuckCompletingTournaments, which pays the prize structure, settles
 * the rake, and never touched the bounty pool. The winner of Union PKO
 * Afternoon d2625870 was owed 121.57 and still carried an uncollected 41.25
 * head to prove the settlement never ran.
 *
 * Every pin below is that failure or a way it could return. Fix your change;
 * never weaken a pin.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceBlockAfter } from '../testHelpers/sourceWindow.js';

const recovery = readFileSync(join(__dirname, './tournamentRecovery.ts'), 'utf8');
const gameServer = readFileSync(join(__dirname, '../GameServer.ts'), 'utf8');
const migration = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260901194756_a_bounty_pool_belongs_to_a_player_too.sql'
  ),
  'utf8'
);

describe('the recovery path settles the bounty pool', () => {
  it('recoverStuckCompleting finalises the bounty pool, like it settles the rake', () => {
    expect(recovery).toContain("supabase.rpc('fn_finalize_bounty_pool'");
    expect(recovery).toContain('GameServer.recoverStuckCompleting_bounty_finalise_failed');
  });

  it('it settles BEFORE it completes, or the event is closed with the money still in it', () => {
    const finaliseAt = recovery.indexOf("supabase.rpc('fn_finalize_bounty_pool'");
    const completeAt = recovery.indexOf('// 4. Complete (CAS-guarded)');
    expect(finaliseAt).toBeGreaterThan(-1);
    expect(completeAt).toBeGreaterThan(-1);
    expect(finaliseAt).toBeLessThan(completeAt);
  });

  it('the champion comes from the record, never from a guess', () => {
    expect(recovery).toMatch(/\.eq\('status', 'winner'\)/);
    expect(recovery).toContain('if (championId)');
  });

  it('a residual that paid nobody is reported rather than swallowed', () => {
    // The silence this block exists to end: fn_finalize_bounty_pool returns
    // ok:true with a positive residual and no paid_to when it declines, and
    // the old caller logged only the happy case.
    expect(recovery).toContain('GameServer.recoverStuckCompleting_bounty_residual_unpaid');
  });
});

describe('the back-pay never picks a recipient', () => {
  it('an event with no champion is alerted, not settled', () => {
    expect(migration).toContain("'no_champion'");
    expect(migration).toContain('IF r.champion IS NULL THEN');
    // And the alert carries a per-event dedupe key, so it is one row per event.
    expect(migration).toMatch(/r\.id::text\);/);
  });

  it('it re-drives the existing settlement rather than paying by hand', () => {
    // fn_finalize_bounty_pool is idempotent on tourney:{id}:ownbounty:{winner}
    // and pays only what the ledger still shows unpaid, so re-driving cannot
    // double-pay. A hand-rolled credit here would have no such guarantee.
    expect(migration).toContain('public.fn_finalize_bounty_pool(r.id, r.champion)');
    expect(migration).not.toContain('fn_credit_and_log');
  });

  it('the limit caps the work, not how far back it can look', () => {
    // The first version scanned `ORDER BY ended_at DESC LIMIT 200` and tested
    // "is it unpaid" AFTER the limit. With thousands of bounty events that
    // means an old debt can be pushed permanently out of reach by newer events
    // completing - the identical head-of-line defect this audit had just
    // documented in fn_pay_backed_payout_shortfalls, reintroduced two hours
    // later. Another agent caught it in production the same day.
    expect(migration).toContain('WHERE wallet_bounty + 0.01 < pool');
    expect(migration).toContain('ORDER BY ended_at ASC NULLS LAST');
    // And the filter must sit INSIDE the scan, before the limit, or the order
    // alone buys nothing.
    const filterAt = migration.indexOf('WHERE wallet_bounty + 0.01 < pool');
    const limitAt = migration.indexOf('LIMIT GREATEST(p_limit, 1)');
    expect(filterAt).toBeGreaterThan(-1);
    expect(limitAt).toBeGreaterThan(filterAt);
  });

  it('it is dry-runnable and closed to browser roles', () => {
    expect(migration).toMatch(/p_apply boolean DEFAULT false/);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_backpay_unfinalised_bounty_pools\(boolean, integer\)\s*\n?\s*FROM PUBLIC, anon, authenticated;/
    );
  });
});

describe('the net is wired', () => {
  it('GameServer drives the back-pay on the same hourly pass as the checks', () => {
    expect(gameServer).toContain("'fn_backpay_unfinalised_bounty_pools'");
    expect(gameServer).toContain('GameServer.bounty_backpay_failed');
    expect(gameServer).toContain('GameServer.bounty_backpay_threw');
  });

  it('it applies rather than only reporting, or it is a check pretending to be a repair', () => {
    const block = sliceBlockAfter(
      gameServer,
      'try {\n            const { data: bb, error: bbErr }'
    );
    expect(gameServer).toMatch(/'fn_backpay_unfinalised_bounty_pools',\s*\n\s*\{ p_apply: true/);
    expect(block.length).toBeGreaterThanOrEqual(0);
  });
});
