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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRejectRebuy } from '../handlers/reject_rebuy.js';
import { sliceBetween } from '../testHelpers/sourceWindow.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const declineIO = vi.hoisted(() => ({ sendJSON: vi.fn(), reportError: vi.fn() }));
vi.mock('../http/respond.js', () => ({ sendJSON: declineIO.sendJSON }));
vi.mock('../http/auth.js', () => ({
  authenticateRequest: vi.fn(async () => ({ userId: 'player' })),
}));
vi.mock('../http/body.js', () => ({
  readBody: vi.fn(async () => JSON.stringify({ tableId: 'table' })),
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: declineIO.reportError }));

describe('the real rebuy decline handler acknowledges only its owner', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([null, undefined, {}])(
    'refuses unavailable engine %s rather than acknowledging a no-op',
    async (engine) => {
      await handleRejectRebuy({} as any, {} as any, {
        gameServer: { getTableEngine: () => engine },
      });
      expect(declineIO.sendJSON).toHaveBeenCalledWith(
        expect.anything(),
        503,
        expect.objectContaining({ success: false })
      );
    }
  );
  it('waits for the durable decline before acknowledging it', async () => {
    let finish!: () => void;
    const rejectRebuy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const work = handleRejectRebuy({} as any, {} as any, {
      gameServer: { getTableEngine: () => ({ rejectRebuy }) },
    });
    await vi.waitFor(() => expect(rejectRebuy).toHaveBeenCalledWith('player'));
    expect(declineIO.sendJSON).not.toHaveBeenCalled();
    finish();
    await work;
    expect(declineIO.sendJSON).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });
  it('does not acknowledge a failed durable decline', async () => {
    await handleRejectRebuy({} as any, {} as any, {
      gameServer: {
        getTableEngine: () => ({
          rejectRebuy: async () => {
            throw new Error('Lost receipt');
          },
        }),
      },
    });
    expect(declineIO.sendJSON).toHaveBeenCalledWith(expect.anything(), 500, expect.anything());
    expect(declineIO.sendJSON).not.toHaveBeenCalledWith(expect.anything(), 200, expect.anything());
  });
});

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
        '20260908042000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
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

  it('consumes the atomic rebuy result without a later manager reseat', () => {
    const block = sliceBetween(
      ELIM,
      'const { rebought, answered } = await this.tryTournamentRebuys(',
      'THE REBUY DECISION WINDOW'
    );
    expect(block).toContain('The rebuy transaction owns its exact playable chair and stack.');
    expect(block).not.toContain('ensureLateRegSeated');
    expect(block).not.toContain('assignTournamentPlayerSeatAtomically');
    expect(block).not.toContain("from('table_seats')");
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

describe('the SQL side matches: a paid rebuy commits its seat or nothing', () => {
  it('the sole purchase transaction binds the accepted bust, money, seat, mirrors and receipt', () => {
    const sql = fs.readFileSync(
      path.join(
        MIGRATIONS,
        '20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
      ),
      'utf8'
    );
    const purchase = sliceBetween(
      sql,
      'CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(',
      'REVOKE ALL ON FUNCTION public.process_tournament_rebuy('
    );
    const global = purchase.indexOf('ca:tournament-terminal-settlement:v1');
    const maintenance = purchase.indexOf('pg_advisory_xact_lock_shared(530090,1)');
    const claim = purchase.indexOf('fn_claim_entry_purchase_receipt');
    const freeze = purchase.indexOf('fn_entry_purchases_frozen');
    expect(global).toBeGreaterThan(-1);
    expect(maintenance).toBeGreaterThan(global);
    expect(claim).toBeGreaterThan(maintenance);
    expect(freeze).toBeGreaterThan(claim);
    expect(purchase).toContain('fn_ca_latest_committed_knockout_candidate');
    expect(purchase).toContain('fn_ca_process_tournament_chip_purchase_money_v1');
    expect(purchase).toContain('UPDATE public.tournament_knockout_candidates c');
    expect(purchase).toContain('fn_ca_choose_tournament_seat_locked');
    expect(purchase).toContain('fn_ca_assign_tournament_player_seat_locked');
    expect(purchase).toContain('fn_emit_tournament_manager_wake');
    expect(purchase).toContain('fn_record_entry_purchase_receipt');
    expect(purchase).toContain("'atomic_tournament_chip_purchase','v1'");
    expect(purchase).not.toMatch(/double_submit_collapsed|process_tournament_rebuy_before_/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.fn_ca_process_tournament_chip_purchase_money_v1\([\s\S]*?service_role;/
    );
  });

  it('opens each prompt once under row locks and reports database-time state', () => {
    const sql = fs.readFileSync(
      path.join(
        MIGRATIONS,
        '20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path.sql'
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
