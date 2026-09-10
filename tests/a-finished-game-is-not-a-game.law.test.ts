/**
 * A FINISHED GAME IS NOT A GAME, AND A CAP IS NOT A FAILURE (2026-09-10).
 *
 * Friday Night Feature Satellite Heads-Up sat RUNNING for sixteen hours with
 * its 38.00 in escrow. The engine had finished it and called
 * fn_settle_satellite_finish_atomic; delivery tried to seat the winner in the
 * target event, the booking-cap trigger counted his games, found five, and
 * raised FOUR TABLE LIMIT. The atomic settlement caught that, returned
 * retryable=false, and nothing could ever complete the event.
 *
 * Two causes, two lines:
 *  - fn_concurrent_game_load counted the winner's own seat at the satellite
 *    that was finishing. A seat at a COMPLETING / COMPLETED / CANCELLED
 *    tournament's table is history, like a seat at a closed table.
 *  - fn_deliver_satellite_ticket_exact never asked whether the seat could be
 *    taken. It now takes the cap trigger's lock, reads the cap trigger's
 *    count, and delivers the frozen value as cash (four_table_cap) instead
 *    of attempting a seat that is bound to be refused.
 *
 * And, found on the way: the wallet a tournament entry is DEBITED from and
 * the wallet the entry is STAMPED with (where its prize returns) were
 * resolved by two different functions. 3,232 union entries in 24h were
 * charged at the union's house club and paid to the member club. The debit
 * now reads the same resolver as the stamp.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const sorted = () =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const migrationNamed = (slug: string): string => {
  const hit = sorted().filter((f) => f.endsWith(`_${slug}.sql`));
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};
/** The newest migration that (re)defines a function is the definition that is live. */
const latestDefinitionOf = (fn: string): { file: string; body: string } | null => {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i');
  for (const f of sorted().reverse()) {
    const body = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    if (re.test(body)) return { file: f, body };
  }
  return null;
};

const CAP = migrationNamed('a_finished_game_is_not_a_game_and_a_cap_is_not_a_failure');
const WALLET = migrationNamed('the_entry_is_charged_to_the_wallet_the_entry_is_stamped_with');

describe('a finished game is not a game', () => {
  it('fn_concurrent_game_load excludes a seat at a finished tournament', () => {
    expect(CAP).toContain("tr1.status IN ('COMPLETING', 'COMPLETED', 'CANCELLED')");
  });

  it('the newest definition of fn_concurrent_game_load on disk still carries the exclusion', () => {
    const live = latestDefinitionOf('fn_concurrent_game_load');
    expect(live, 'fn_concurrent_game_load must be defined by a migration').not.toBeNull();
    expect(
      live!.body,
      `${live!.file} redefines fn_concurrent_game_load without the finished-game exclusion`
    ).toContain("tr1.status IN ('COMPLETING', 'COMPLETED', 'CANCELLED')");
  });

  it('keeps the closed-table exclusion and the never-both rule that were already there', () => {
    expect(CAP).toContain("AND t.status <> 'closed'");
    expect(CAP).toContain('-- NEVER BOTH.');
  });
});

describe('a cap is not a failure', () => {
  it('decides cash before any write, under the lock the cap triggers take', () => {
    expect(CAP).toContain(
      "pg_advisory_xact_lock(hashtextextended(''table_cap:'' || p_user_id::text, 0))"
    );
    expect(CAP).toContain('fn_concurrent_game_load(p_user_id, NULL, NULL, p_target_id) >= 4');
    expect(CAP).toContain("v_cash_reason := ''four_table_cap''");
  });

  it('is an asserted substitution: the anchor must appear exactly once', () => {
    expect(CAP).toContain('expected exactly 1');
    expect(CAP).toContain('post-condition: four_table_cap appears % times, expected 1');
  });

  it('proves every cap reader still reads the one load function', () => {
    expect(CAP).toContain("'fn_enforce_booking_game_cap', 'fn_enforce_four_table_limit'");
    expect(CAP).toContain(
      "'fn_settle_satellite_tournament_pre_money_path_gate', 'fn_deliver_satellite_ticket_exact'"
    );
    expect(CAP).toContain('<> 4 THEN');
  });
});

describe('the entry is charged to the wallet the entry is stamped with', () => {
  it('the debit resolves a tournament wallet through fn_tournament_club_for_user, twice (table and entity)', () => {
    const live = latestDefinitionOf('atomic_deduct_wallet_and_log');
    expect(live).not.toBeNull();
    const n = (live!.body.match(/fn_tournament_club_for_user\(/g) ?? []).length;
    expect(
      n,
      `${live!.file}: the debit must resolve through the stamp's resolver`
    ).toBeGreaterThanOrEqual(2);
    // The direct read of tournaments.club_id appears once: quoted inside the
    // post-condition that forbids it. Any second occurrence is the read itself.
    const direct = (live!.body.match(/SELECT t\.club_id INTO v_context_club/g) ?? []).length;
    expect(direct, `${live!.file} reads tournaments.club_id directly again`).toBeLessThanOrEqual(1);
  });

  it('refuses out loud when no wallet in the union resolves, never charges an unrelated club', () => {
    expect(WALLET).toContain('no club wallet in the union of tournament % resolves for player %');
    expect(WALLET).toContain("USING ERRCODE='42501'");
  });

  it('corrects only in-flight entries, asserts the count, and never touches a batched or completed event', () => {
    expect(WALLET).toContain("t.status IN ('REGISTERING', 'RUNNING', 'COMPLETING')");
    expect(WALLET).toContain('tournament_place_settlement_batches');
    expect(WALLET).toContain('tournament_satellite_settlement_batches');
    expect(WALLET).toContain('tournament_final_table_deal_batches');
    expect(WALLET).toContain('one-time correction changed % rows, expected %');
    expect(WALLET).toContain('are still stamped with a wallet they were not charged at');
  });

  it('re-stamps to the wallet the ledger proves was charged, never to a guess', () => {
    expect(WALLET).toContain("l.category = 'tournament_buyin' AND l.from_type = 'player_wallet'");
    expect(WALLET).toContain("l.to_type = 'prize_liability'");
    expect(WALLET).toContain('SET club_id = f.charged_club');
  });
});
