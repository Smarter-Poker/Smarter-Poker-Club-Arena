/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE CASH-OUT PATH, ONE SEAT CREATOR, A REBUY THAT CANNOT BE ERASED
 *  (Chip Accounting Standard, Lane D, 2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * docs/CHIP-ACCOUNTING-STANDARD.md section 2.3 lists the cash-side defects
 * that were latent (none of them the drift, all of them a way to lose money
 * later). This law pins what closed them, so that nobody quietly reopens one:
 *
 *   C1  atomic_table_cashout carried its OWN unkeyed copy of the credit, so a
 *       retry of a committed-but-unacknowledged call paid twice. It is a
 *       wrapper over atomic_seat_cashout_locked now (keyed per seat
 *       occupancy). atomic_table_withdraw passed a NULL idempotency key; it
 *       takes one now and checks it BEFORE the stack moves. The browser has
 *       no cash-out path of its own: it defers to the engine, and only
 *       cashes out through the one keyed function when the engine hands it
 *       the cleanup explicitly.
 *
 *   C2  HydraService.seatHorse INSERTed table_seats with a browser-chosen
 *       stack and debited nobody. It is gone. A seat guard trigger watches
 *       every funded seat creation on table_seats; by Dan's ruling
 *       (2026-09-02: nothing high-risk for live play is enforced) it LOGS what
 *       it would refuse to ca_seat_guard_dryrun and never raises. Flipping it
 *       to refuse is a follow-up after 24h of an empty log.
 *
 *   C3  atomic_table_rebuy did `table_seats.stack += n` while the retired
 *       stack-only writer wrote ABSOLUTELY from memory - a rebuy landing
 *       between loadSeatedPlayers and the next sync was erased while the
 *       wallet stayed debited. The RPC writes a table_pending_addons row
 *       (kind 'rebuy') instead; the engine treats that row as the busted
 *       player's answer, requests a sweep, and delivers it into memory
 *       before the next deal. A sweep request that lands while a sweep is
 *       mid-read survives it (generation counter).
 *
 *   C5  player_leave_table and fn_cashout_seats_for_closing_table declare the
 *       ledger (table_cashout / table_stack) before the credit and delegate
 *       to the one cash-out function, so a cron eviction is no longer an
 *       anonymous 'adjustment' in chip_ledger.
 *
 *   C6  Four cash money RPCs existed only in pg_proc. They are mirrored into
 *       the repo byte-exact, with the md5 of each live body in the header;
 *       this law recomputes the md5 of each mirrored body and checks it
 *       against that header, so the mirror cannot drift from what it claims.
 *
 * Every pin here was negative-controlled: the source was mutated to the old
 * shape, the pin went red, the source was restored.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MAIN = read('supabase/migrations/20260902174500_cash_one_cashout_path_one_seat_creator.sql');
const GUARD = read(
  'supabase/migrations/20260902174600_the_seat_guard_watches_before_it_refuses.sql'
);
const MIRROR = read('supabase/migrations/20260902185000_mirror_production_only_cash_rpcs.sql');
const TABLE_SERVICE = read('src/services/TableService.ts');
const HYDRA = read('src/services/HydraService.ts');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const ENGINE_BASE = read('server/src/engine/ServerTableEngineBase.ts');
const ENGINE_SEATING = read('server/src/engine/ServerTableEngineSeating.ts');
const ENGINE_DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
const LEAVE_HANDLER = read('server/src/handlers/leave.ts');

/** The text of one `CREATE [OR REPLACE] FUNCTION public.<name>(` body in a migration. */
function functionBody(sql: string, name: string): string {
  const head = Math.max(
    sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`),
    sql.indexOf(`CREATE FUNCTION public.${name}(`)
  );
  expect(head, `${name} is not defined in the migration`).toBeGreaterThan(-1);
  const open = sql.indexOf('AS $function$', head);
  const close = sql.indexOf('$function$;', open + 1);
  expect(open).toBeGreaterThan(head);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open + 'AS $function$'.length, close);
}

describe('C3: a rebuy is a pending add-on, never a relative stack write', () => {
  const rebuy = functionBody(MAIN, 'atomic_table_rebuy');

  it('atomic_table_rebuy writes table_pending_addons with kind rebuy', () => {
    expect(rebuy).toMatch(
      /INSERT INTO public\.table_pending_addons \(table_id, user_id, amount, kind\)/
    );
    expect(rebuy).toMatch(/'rebuy'\)/);
  });

  it('and never touches table_seats.stack', () => {
    expect(rebuy).not.toMatch(/SET\s+stack\s*=/i);
  });

  it('the pending ledger only admits addon and rebuy', () => {
    expect(MAIN).toMatch(/CHECK \(kind IN \('addon', 'rebuy'\)\)/);
  });

  it('the engine counts an unresolved ledger row as the busted player answering', () => {
    // waitForRebuyDecisions -> drainAnswered asks the ledger after the stack read.
    const pause = ENGINE_BASE.slice(
      ENGINE_BASE.indexOf('protected async waitForRebuyDecisions('),
      ENGINE_BASE.indexOf('protected dealerSeatIndex')
    );
    expect(pause).toMatch(/usersWithPendingLedgerChips\(Array\.from\(pending\)\)/);
    expect(pause).toMatch(/if \(inFlight\) for \(const id of inFlight\) pending\.delete\(id\)/);
  });

  it('the busted-seat stand-up asks the ledger before releasing anyone', () => {
    const standUp = ENGINE_DEALING.slice(
      ENGINE_DEALING.indexOf('protected async standUpBustedCashPlayers('),
      ENGINE_DEALING.indexOf(
        'await atomicCashout(player.user_id, this.tableId, player.seat_number)'
      )
    );
    expect(standUp).toMatch(/usersWithPendingLedgerChips\(broke\.map/);
    expect(standUp).toMatch(/if \(owed === null\) return;/);
    expect(standUp).toMatch(/owed\.has\(player\.user_id\)/);
  });

  it('a sweep request that lands mid-sweep cannot be erased (generation counter)', () => {
    expect(ENGINE_BASE).toMatch(/protected pendingAddOnSweepGen = 0;/);
    expect(ENGINE_BASE).toMatch(
      /protected requestPendingAddOnSweep\(\): void \{\s*this\.pendingAddOnSweepNeeded = true;\s*this\.pendingAddOnSweepGen\+\+;/
    );
    const sweep = ENGINE_SEATING.slice(
      ENGINE_SEATING.indexOf('protected async processPendingAddOns('),
      ENGINE_SEATING.indexOf('protected async resolveOrphanedAddOns(')
    );
    expect(sweep).toMatch(/const genAtStart = this\.pendingAddOnSweepGen;/);
    // Every place the flag is cleared is gated on the generation.
    const clears = sweep.match(/pendingAddOnSweepNeeded = false/g) ?? [];
    const gated =
      sweep.match(
        /if \(this\.pendingAddOnSweepGen === genAtStart\) this\.pendingAddOnSweepNeeded = false/g
      ) ?? [];
    expect(clears.length).toBeGreaterThan(0);
    expect(gated.length).toBe(clears.length);
  });

  it('the browser mints ONE rebuy idempotency key per bust event and reuses it on retry', () => {
    const confirm = TABLE_PAGE.slice(
      TABLE_PAGE.indexOf('const bustRebuyKeyRef = useRef<'),
      TABLE_PAGE.indexOf('const cancelBustRebuy = useCallback(')
    );
    expect(confirm).toMatch(/bustRebuyKeyRef\.current = \{ amount, key: crypto\.randomUUID\(\) \}/);
    expect(confirm).toMatch(/const idempotencyKey = bustRebuyKeyRef\.current\.key;/);
    // The old shape: a fresh UUID on every attempt.
    expect(confirm).not.toMatch(/const idempotencyKey = crypto\.randomUUID\(\)/);
    // Released only once the purchase landed.
    expect(confirm).toMatch(/bustRebuyKeyRef\.current = null;\s*toast\?\.success/);
  });
});

describe('C1: one cash-out path', () => {
  it('atomic_table_cashout delegates and carries no credit of its own', () => {
    const body = functionBody(MAIN, 'atomic_table_cashout');
    expect(body).toMatch(
      /public\.atomic_seat_cashout_locked\(p_user_id, p_table_id, p_seat_number\)/
    );
    expect(body).not.toMatch(/UPDATE club_members/i);
    expect(body).not.toMatch(/INSERT INTO wallet_transactions/i);
  });

  it('atomic_table_withdraw is keyed, and the key is checked before the stack moves', () => {
    const body = functionBody(MAIN, 'atomic_table_withdraw');
    expect(MAIN).toMatch(/p_idempotency_key text DEFAULT NULL::text\)\s*RETURNS numeric/);
    const keyCheck = body.indexOf(
      'IF EXISTS (SELECT 1 FROM wallet_credit_idempotency WHERE key = v_key)'
    );
    const stackWrite = body.indexOf('SET stack = stack - p_amount');
    expect(keyCheck).toBeGreaterThan(-1);
    expect(stackWrite).toBeGreaterThan(keyCheck);
    // The four-argument overload is gone so PostgREST sees one candidate.
    expect(MAIN).toMatch(
      /DROP FUNCTION IF EXISTS public\.atomic_table_withdraw\(uuid, uuid, numeric, boolean\);/
    );
  });

  it('the browser never calls atomic_table_cashout', () => {
    for (const file of [
      'src/services/TableService.ts',
      'src/services/HydraService.ts',
      'src/services/WalletService.ts',
    ]) {
      expect(read(file)).not.toMatch(/rpc\(\s*'atomic_table_cashout'/);
    }
  });

  it('the browser delegates leave to the persisted occupancy contract and never writes money', () => {
    const leave = TABLE_SERVICE.slice(
      TABLE_SERVICE.indexOf('async leaveTable('),
      TABLE_SERVICE.indexOf('subscribeToTable(')
    );
    expect(leave).toContain('leaveSeatWithIntent(tableId, userId)');
    expect(leave).not.toMatch(/supabase\.rpc|clientCashout|atomic_seat_cashout_locked/);
    expect(leave).toContain('return result');
    expect(leave).toContain('result.deferred');
  });

  it('retired requests cannot delegate cashout to the browser or claim success', () => {
    expect(LEAVE_HANDLER).toContain("code: 'SEAT_OCCUPANCY_REQUIRED'");
    expect(LEAVE_HANDLER).toContain('reloadRequired: true');
    expect(LEAVE_HANDLER).not.toMatch(/success: true|clientCashout/);
    expect(ENGINE_SEATING).not.toContain('clientCashout');
    const bound = read('server/src/handlers/leaveOccupancy.ts');
    expect(bound).toContain('getSeatCashoutReceipt');
    expect(bound).toContain('engine.leaveTable');
    expect(bound).not.toMatch(/clientCashout|supabase\.rpc/);
  });

  it('HydraService.removeHorse refuses instead of cashing a horse out from the browser', () => {
    const body = HYDRA.slice(
      HYDRA.indexOf('async removeHorse('),
      HYDRA.indexOf('async onRealPlayerJoined(')
    );
    expect(body).toMatch(/HydraService\.removeHorse_refused_client_cashout/);
    expect(body).not.toMatch(/rpc\(/);
  });
});

describe('C2: one seat creator', () => {
  it('HydraService no longer INSERTs table_seats', () => {
    expect(HYDRA).not.toMatch(/async seatHorse\(/);
    expect(HYDRA).not.toMatch(/from\('table_seats'\)\s*\.insert\(/);
  });

  it('the five sanctioned creators are patched to declare app.money_path', () => {
    for (const fn of [
      'atomic_table_buyin',
      'fn_take_seat_and_buy_in',
      'fn_seat_horse_in_seat_first_game',
      'fn_seat_late_registrant',
      'fn_horse_seat_from_treasury',
    ]) {
      expect(MAIN).toContain(`'${fn}'`);
    }
    expect(MAIN).toMatch(/PERFORM set_config\(''app\.money_path'', ''' \|\| r\.proname/);
  });

  it('seat_horse, the unfunded seat creator, is dropped', () => {
    expect(MAIN).toMatch(
      /DROP FUNCTION IF EXISTS public\.seat_horse\(uuid, uuid, integer, numeric\);/
    );
  });

  it('the seat guard is attached in dry-run form: it logs, it never raises (Dan 2026-09-02)', () => {
    const body = functionBody(GUARD, 'fn_ca_guard_seat_creation');
    expect(body).toMatch(/INSERT INTO public\.ca_seat_guard_dryrun/);
    expect(body).not.toMatch(/RAISE\s+EXCEPTION/i);
    expect(GUARD).toMatch(
      /CREATE TRIGGER trg_ca_guard_seat_creation\s*BEFORE INSERT OR UPDATE OF left_at ON public\.table_seats/
    );
    // And the post-apply assertion refuses an enforcing body under this name.
    expect(GUARD).toMatch(/IF v_src ~\* 'RAISE\\s\+EXCEPTION' THEN/);
  });

  it('the dry-run log is not readable by the browser', () => {
    expect(GUARD).toMatch(
      /REVOKE ALL ON TABLE public\.ca_seat_guard_dryrun FROM PUBLIC, anon, authenticated;/
    );
    expect(GUARD).toMatch(/ALTER TABLE public\.ca_seat_guard_dryrun ENABLE ROW LEVEL SECURITY;/);
  });
});

describe('C5: an eviction cash-out is described before it is credited', () => {
  it.each(['player_leave_table', 'fn_cashout_seats_for_closing_table'])(
    '%s declares the ledger and delegates',
    (fn) => {
      const body = functionBody(MAIN, fn);
      const declare = body.indexOf(
        "fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id)"
      );
      const credit = body.indexOf('atomic_seat_cashout_locked(');
      expect(declare).toBeGreaterThan(-1);
      expect(credit).toBeGreaterThan(declare);
      expect(body).not.toMatch(/fn_add_chips/);
      expect(body).not.toMatch(/UPDATE public\.club_members/i);
    }
  );
});

describe('C6: the mirror says what it mirrors, and it is true', () => {
  const NAMES = [
    'fn_ca_settle_hand_stacks_absolute',
    'resolve_pending_addon',
    'fn_add_chips',
    'credit_club_wallet_rake',
  ];

  it.each(NAMES)('%s body md5 matches the header', (name) => {
    const header = MIRROR.match(new RegExp(`--   ${name}\\s+([0-9a-f]{32})`));
    expect(header, `${name} has no md5 in the header`).not.toBeNull();
    const body = functionBody(MIRROR, name);
    expect(createHash('md5').update(body).digest('hex')).toBe(header![1]);
  });

  it('refuses to run against a production that has moved on (never reverts a newer body)', () => {
    expect(MIRROR).toMatch(/mirror pre-flight: % live md5 % differs from mirrored %/);
  });
});
