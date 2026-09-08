/**
 * A PAID REBUY IS NEVER OVERRUN BY THE BUST SWEEP, AND A TOURNAMENT TABLE
 * NEVER PAUSES FOR ONE (Dan, 2026-08-30).
 *
 * The incident, with the production timestamps: rebuy debit 21:13:57.405,
 * elimination UPDATE 21:13:57.911, seat vacated 21:13:59.162. The player paid
 * 200, was granted 30,000 chips, and was stamped out of the tournament half a
 * second later off the sweep's pre-rebuy snapshot.
 *
 * Dan's directive, verbatim: "REBUYS IN A TOURNAMENT SHOULD NOT PAUSE THE
 * ACTION, IT SHOUD TRIGGER THE REBUY OFFER, THEN SIT THE PLAYER REBUYING AT
 * ANY TABLE THAT NEEDS TO BE BALANCED, OR AT ANY SEAT THAT IS OPEN OR WHERE A
 * PLAYER IS NEEDED FIRST, IF THEY TRULY SHOULD BE IN THE SAME TABLE, SAME
 * SEAT, ITS ALLOWED."
 */
import { describe, expect, it } from 'vitest';
import { sliceBetween } from '../testHelpers/sourceWindow.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '..', '..', '..', 'supabase', 'migrations');
const ELIM = fs.readFileSync(path.join(HERE, 'TournamentManagerEliminations.ts'), 'utf8');
const DEALING = fs.readFileSync(
  path.join(HERE, '..', 'engine', 'ServerTableEngineDealing.ts'),
  'utf8'
);
const ENGINE_BASE = fs.readFileSync(
  path.join(HERE, '..', 'engine', 'ServerTableEngineBase.ts'),
  'utf8'
);
const REJECT_HANDLER = fs.readFileSync(
  path.join(HERE, '..', 'handlers', 'reject_rebuy.ts'),
  'utf8'
);

describe('the elimination CAS re-checks the chips, not just the status', () => {
  it('eliminatePlayer refuses a row whose chips came back above zero', () => {
    const sql = fs.readFileSync(
      path.join(
        MIGRATIONS,
        '20260907180000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
      ),
      'utf8'
    );
    const window = sliceBetween(sql, 'fn_eliminate_tournament_player_atomic(', '$function$;');
    expect(window).toMatch(/COALESCE\(v_p\.chips,0\) > 0/);
    expect(window).toMatch(/status='playing' AND COALESCE\(chips,0\)<=0/);
  });
});

describe('a busted player holds an open decision window, and the felt rolls on', () => {
  it('the sweep defers eliminating anyone whose rebuy offer is still open', () => {
    expect(ELIM).not.toMatch(/REBUY_DECISION_GRACE_MS/);
    expect(ELIM).not.toMatch(/rebuyDecisionGraceUntil/);
    const block = sliceBetween(ELIM, 'THE REBUY DECISION WINDOW', 'bustedOrdered');
    expect(block).toMatch(/fn_open_tournament_rebuy_decisions/);
    expect(block).toMatch(/decision_open/);
  });

  it('a horse that answered this pass is not deferred - its decision is final', () => {
    // Horses decide inside tryTournamentRebuys (their input device); the
    // window is identical for everyone, a horse simply replies immediately.
    expect(ELIM).toMatch(/answered\.has\(b\.user_id\)/);
  });

  it('re-drives an unresolved bust every five seconds until acceptance or expiry', () => {
    const wakeAt = ELIM.indexOf('TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS');
    const emptyReturnAt = ELIM.indexOf('if (busted.length === 0) return', wakeAt);
    expect(wakeAt).toBeGreaterThan(-1);
    expect(emptyReturnAt).toBeGreaterThan(wakeAt);
  });

  it('never invents or clears a human deadline in process memory', () => {
    const block = sliceBetween(ELIM, 'THE REBUY DECISION WINDOW', 'bustedOrdered');
    expect(block).not.toMatch(/Date\.now\(\)\s*\+\s*30_?000/);
    expect(block).not.toMatch(/rebuyDecisionGraceUntil/);
    expect(block).toContain('if (!decisions.has(b.user_id)) return false;');
  });

  it('tournament tables never pause the felt for a rebuy', () => {
    expect(
      DEALING.indexOf('REBUYS IN A TOURNAMENT SHOULD'),
      "Dan's ruling must be quoted at the site it governs"
    ).toBeGreaterThan(-1);
    const block = sliceBetween(DEALING, 'REBUYS IN A TOURNAMENT SHOULD', 'catch (err)');
    expect(block).not.toMatch(/needsRebuyPause = true/);
    // The CASH pause survives untouched — section 10.5 still applies there.
    expect(DEALING).toMatch(/setLoopPhase\('rebuy_pause'\)/);
  });

  it('persists a tournament decline before acknowledging the HTTP request', () => {
    const engineBlock = sliceBetween(
      ENGINE_BASE,
      'public async rejectRebuy',
      'protected async waitForRebuyDecisions'
    );
    expect(engineBlock).toMatch(/fn_decline_tournament_rebuy/);
    expect(engineBlock.indexOf('await supabase.rpc')).toBeLessThan(
      engineBlock.indexOf('this.rejectedRebuys.add')
    );
    expect(REJECT_HANDLER).toMatch(/await engine\.rejectRebuy\(user\.userId\)/);
  });
});

describe('the SQL side matches: a rebuy needs no seat', () => {
  it('the latest process_tournament_rebuy only demands a live seat for add-ons', () => {
    const owning = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        fs
          .readFileSync(path.join(MIGRATIONS, f), 'utf8')
          .includes('FUNCTION public.process_tournament_rebuy')
      );
    expect(owning.length).toBeGreaterThan(0);
    const sql = fs.readFileSync(path.join(MIGRATIONS, owning[owning.length - 1]), 'utf8');
    const maintenanceWrapper = sliceBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(',
      'REVOKE ALL ON FUNCTION public.process_tournament_rebuy('
    );
    expect(maintenanceWrapper).toMatch(/pg_advisory_xact_lock_shared\(530090, 1\)/);
    expect(maintenanceWrapper).toMatch(/fn_entry_purchases_frozen\(\)/);
    expect(maintenanceWrapper).toMatch(
      /process_tournament_rebuy_before_maintenance_announcement_gate/
    );
    expect(maintenanceWrapper).not.toMatch(/table_seats|seat_number|left_at/);

    // The outer maintenance boundary deliberately delegates the already-
    // audited lifecycle and seat contract instead of duplicating it. Follow
    // that private core so this law continues to pin the distinction between
    // a seatless rebuy and an add-on that must land on one live seat.
    const lifecycleSql = fs.readFileSync(
      path.join(MIGRATIONS, '20260907205918_tournament_places_settle_and_complete_atomically.sql'),
      'utf8'
    );
    const lifecycleWrapper = sliceBetween(
      lifecycleSql,
      'CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(',
      'REVOKE ALL ON FUNCTION public.process_tournament_rebuy('
    );
    expect(lifecycleWrapper).toMatch(/IF p_rebuy_type = 'addon' THEN/);
    expect(lifecycleWrapper).toMatch(/ELSIF p_rebuy_type IN \('rebuy', 'reentry'\) THEN/);
    expect(lifecycleWrapper).not.toMatch(/table_seats|seat_number|left_at/);
    expect(lifecycleWrapper).toMatch(/process_tournament_rebuy_before_one_minute_addon/);
    expect(lifecycleWrapper).toMatch(
      /IF COALESCE\(v_t\.prize_pool_finalized, false\) THEN[\s\S]*?chip purchases are closed/
    );
  });

  it('opens each prompt once under row locks and reports database-time state', () => {
    const sql = fs.readFileSync(
      path.join(
        MIGRATIONS,
        '20260907203000_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path.sql'
      ),
      'utf8'
    );
    const block = sliceBetween(sql, 'fn_open_tournament_rebuy_decisions(', '$function$;');
    expect(block).toMatch(/FROM public\.tournaments t[\s\S]*FOR UPDATE/);
    expect(block).toMatch(/FROM public\.tournament_players tp[\s\S]*FOR UPDATE/);
    expect(block).toMatch(/tp\.rebuy_prompt_until IS NULL/);
    expect(block).toMatch(/decision_open boolean/);
    expect(sql).toMatch(/fn_decline_tournament_rebuy[\s\S]*fn_emit_tournament_manager_wake/);
    const decline = sliceBetween(sql, 'fn_decline_tournament_rebuy(', '$function$;');
    expect(decline).toContain('v_jwt_role text := auth.role()');
    expect(decline).toContain("v_jwt_role IS DISTINCT FROM 'service_role'");
    expect(decline).toMatch(/v_auth IS NULL OR v_auth<>p_user_id/);
    expect(decline).not.toMatch(/\bIF\s+current_user/);
  });
});
