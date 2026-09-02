/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WALLET CREDIT INTEGRITY — every credit is keyed, and nothing logs twice
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two rules, both learned the expensive way, enforced across the WHOLE server
 * rather than at the individual sites that happened to break.
 *
 * ── RULE 1: a credit carries an idempotency key ─────────────────────────────
 *
 * Every credit site sits behind a retry, a boot sweep, a watchdog, or all
 * three. Without a key, a credit that COMMITTED but timed out is paid again.
 * That has happened here repeatedly — the 2026-07-24, 2026-07-28 and
 * 2026-08-22 fixes are all the same bug at a different site.
 *
 * ── RULE 2: the ledger row is written by whoever moved the money ────────────
 *
 * `credit_player_wallet` dedupes on the key and RETURNS VOID, so the loser of
 * a race cannot tell it credited nothing. Any site that follows it with an
 * unconditional `log_wallet_transaction` or `wallet_transactions` insert
 * therefore writes a row for chips it did not move. Measured 2026-08-22 on the
 * tournament prize paths: 95 phantom rows, 7,446.45 chips, over two days.
 * Balances were correct; the ledger was not, and profit, rakeback and the
 * leaderboards are computed from the ledger.
 *
 * Three RPCs are safe to call because they do both halves under the one key:
 *
 *   fn_credit_and_log              general purpose, writes wallet_transactions
 *   atomic_credit_wallet_and_log   table cash-outs; resolves the SEAT's club
 *                                  first and mirrors to chip_transactions
 *   fn_credit_player_wallet_once   the primitive — returns whether it credited,
 *                                  for the one caller that needs to compute
 *                                  balance_after itself
 *
 * They are NOT interchangeable and must not be "consolidated": only
 * atomic_credit_wallet_and_log knows about seat provenance, and only
 * credit_player_wallet / fn_credit_player_wallet_once parse a `tourney:` key
 * to find the club through tournament_players. Picking the wrong one credits
 * the wrong club's wallet — which is exactly what atomicCashout was doing
 * against its own sibling until 2026-08-22.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (entry.endsWith('.ts') && !entry.includes('.test.')) out.push(rel);
  }
  return out;
}

const SERVER_FILES = walk('server/src');

const CREDIT_RPCS = [
  'credit_player_wallet',
  'atomic_credit_wallet_and_log',
  'fn_credit_and_log',
  'fn_credit_player_wallet_once',
] as const;

/** Every credit call site: { file, line, rpc, body }. */
function creditCallSites() {
  const re = new RegExp(
    `rpc\\(\\s*'(${CREDIT_RPCS.join('|')})'\\s*,\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*\\)`,
    'g'
  );
  const sites: Array<{ file: string; line: number; rpc: string; body: string }> = [];
  for (const file of SERVER_FILES) {
    const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    for (const m of src.matchAll(re)) {
      sites.push({
        file,
        line: src.slice(0, m.index ?? 0).split('\n').length,
        rpc: m[1],
        body: m[2],
      });
    }
  }
  return sites;
}

describe('every wallet credit in the server carries an idempotency key', () => {
  const sites = creditCallSites();

  it('finds the credit sites at all (guards against the regex silently rotting)', () => {
    /* LOWERED 10 -> 9 on 2026-08-31, and it is a credit site REMOVED rather
       than a regex that rotted. GameServer's boot sweep no longer credits a
       wallet itself: it calls `atomic_seat_cashout_locked`, which credits and
       vacates the seat inside ONE transaction and derives its idempotency key
       from the row it locked. That is the property this file is about, moved
       into the database where the lock is - so the site is gone and the rule
       is stronger. The floor exists to catch the regex silently matching
       nothing; it is not a target.

       LOWERED 9 -> 1 on 2026-09-02 (chip accounting standard, Lane A2), and
       again it is sites REMOVED, not a regex that rotted. The eight tournament
       `fn_credit_and_log` sites (place at bust, place 1 at finish, bubble
       protection, late-reg top-up, final-table deal, cancel refund, recovery
       places + top-ups, satellite cash) all became
       `settleTournamentObligation()` -> `fn_settle_tournament_obligation`,
       which derives its idempotency key from the obligation row it settles.
       The one site left is the cash-table add-on refund via
       `atomic_credit_wallet_and_log`. The single-path rule for tournaments is
       pinned server-side by OneSettlePathForTournamentMoney.law.test.ts. */
    expect(sites.length).toBeGreaterThanOrEqual(1);
  });

  for (const s of sites) {
    it(`${s.file}:${s.line} — ${s.rpc}`, () => {
      expect(s.body, 'a credit without a key is paid twice on any retry').toContain(
        'p_idempotency_key'
      );
    });
  }
});

describe('no site credits and then logs as a separate, ungated step', () => {
  /**
   * The shape being banned:
   *
   *     await supabase.rpc('credit_player_wallet', { ...key })   // deduped
   *     await supabase.rpc('log_wallet_transaction', { ... })    // NOT deduped
   *
   * A `wallet_transactions` insert within reach of a credit is the same thing
   * written by hand. The one permitted case is a `fn_credit_player_wallet_once`
   * call whose result gates the write.
   */
  const WINDOW = 34;

  for (const file of SERVER_FILES) {
    const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    if (!CREDIT_RPCS.some((r) => src.includes(`rpc('${r}'`))) continue;
    const lines = src.split('\n');

    it(`${file}`, () => {
      lines.forEach((line, i) => {
        const rpc = CREDIT_RPCS.find((r) => line.includes(`rpc('${r}'`));
        if (!rpc) return;
        const window = lines.slice(i, i + WINDOW).join('\n');
        const logsSeparately =
          window.includes("rpc('log_wallet_transaction'") ||
          (window.includes("from('wallet_transactions')") && window.includes('.insert('));
        if (!logsSeparately) return;

        // Permitted only when the credit reports back and the write is gated.
        expect(
          rpc === 'fn_credit_player_wallet_once' &&
            /didCredit|=== false|if \(!\w*[Cc]redit/.test(window),
          `${file}:${i + 1} credits via ${rpc} and then writes a ledger row that is not gated ` +
            `on whether the credit actually happened — the phantom-row shape`
        ).toBe(true);
      });
    });
  }
});

describe('the two table cash-out paths cannot diverge again', () => {
  const seats = stripComments(
    readFileSync(join(ROOT, 'server/src/services/supabase/seats.ts'), 'utf8')
  );

  /* 2026-08-27: these two assertions still guard "the two paths cannot
     diverge", but the mechanism they guard changed, so they had to change with
     it (they are updated in the same commit that moved the behaviour, per the
     never-push-a-red-test rule).

     Both paths used to credit via `atomic_credit_wallet_and_log` here in
     TypeScript, keyed with `cashoutKey(seat)`. That shape was the bug: the
     stack was read in a SEPARATE transaction from the credit, with no lock, so
     an add-on could commit in the gap and its chips were destroyed. Read,
     credit and vacate now happen inside `atomic_seat_cashout_locked` under
     FOR UPDATE, and the key is derived from the locked row.

     The invariant is stronger than before rather than weaker: there is now
     exactly ONE implementation of "cash a seat out", so the two paths cannot
     drift apart at all - which is what this describe block has always been
     about. */
  it('markSeatAsLeft and atomicCashout call the SAME rpc', () => {
    const calls = [...seats.matchAll(/rpc\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    const cashouts = calls.filter((c) => c === 'atomic_seat_cashout_locked');
    expect(cashouts.length, 'both cash-out paths should cash out').toBe(2);
    expect(new Set(cashouts).size, 'the two paths must use one RPC').toBe(1);
  });

  it('neither path credits or vacates outside that rpc', () => {
    /* A credit or a left_at stamp out here is a second transaction, and a
       second transaction is the race. */
    expect(seats).not.toMatch(/atomic_credit_wallet_and_log/);
    expect(seats).not.toMatch(/left_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  it('atomicCashout no longer hand-writes its own wallet_transactions row', () => {
    // It used to, unconditionally, while sharing a key with its sibling — so
    // the second path to run logged a cash-out it had not performed.
    expect(seats).not.toMatch(/from\('wallet_transactions'\)[\s\S]{0,80}\.insert\(/);
  });
});

describe('the dead horse-winnings path stays dead', () => {
  const lifecycle = readFileSync(
    join(ROOT, 'server/src/services/HorseLifecycleManager.ts'),
    'utf8'
  );

  it('processWinnings is gone', () => {
    // Unkeyed credit, unused tournamentId (so no related_entity_id, invisible
    // to fn_tournament_payout_reconcile), and a category used nowhere else.
    expect(stripComments(lifecycle)).not.toMatch(/processWinnings/);
  });

  it("the orphan 'tournament_winnings' category is gone with it", () => {
    expect(stripComments(lifecycle)).not.toMatch(/tournament_winnings/);
  });
});

describe('the startup cash-out is accounted for', () => {
  const gs = stripComments(readFileSync(join(ROOT, 'server/src/GameServer.ts'), 'utf8'));

  /* ── REPLACED 2026-08-31, and the replacement is stricter ────────────────
     This used to pin `startup-cashout:{userId}:{sorted seat ids}` next to an
     `atomic_credit_wallet_and_log` call, because the rule it was defending was
     "the boot cash-out writes a ledger row at all" - it used to call
     credit_player_wallet and log nothing.

     That rule is now satisfied by a stronger mechanism, so the pin moves to it
     rather than being deleted. The aggregate key was itself the next bug: the
     credit and the seat DELETE were two round trips, so a boot that died
     between them paid the chips and left the seat occupied, and the next boot
     rebuilt the IDENTICAL key, deduped, wrote NO fresh row - and deleted the
     seats anyway. 1,033 exits a day reached fn_unaccounted_seat_exits with no
     credit to match. `atomic_seat_cashout_locked` credits and vacates in ONE
     transaction and derives its key from the row it locked, so every seat
     produces its own matchable ledger row and there is no window to die in. */
  /* ── REPLACED AGAIN 2026-09-02, because the boot cash-out no longer exists ──
     #2713 deleted the block this pinned. cleanupStaleData() cashed out and
     vacated every HORSE seat at every cash table on every boot and then reset
     those horses to available, so the fleet re-seeded fresh ones into the
     holes: measured at the 20:55 break, "Cashed out and vacated 383 seat(s)
     ... (78575.13 chips returned to club wallets)" across 223 cash tables.
     Horses are players (CLAUDE.md 10.5), and a seat row IS the persisted
     state - the engine rebuilds every table from table_seats on boot.

     So there is no boot cash-out to route through the locked RPC, and pinning
     one kept main red for a fix that was correct. The rule this test defends -
     no cash-out may credit chips without a matchable ledger row and a vacated
     seat in the same transaction - has not gone away; it moved. GameServer
     must now perform NO cash-out at all, and the single remaining path lives
     in server/src/services/supabase/seats.ts, where seats.guard.test.ts holds
     it to `atomic_seat_cashout_locked` and to crediting nothing itself.

     Asserting the absence is strictly stronger here than asserting the old
     presence: it fails if anyone reintroduces a boot-time credit by any route,
     not just if they stop using one particular RPC name. */
  it('the boot path performs no cash-out of its own', () => {
    expect(gs).not.toMatch(/atomic_seat_cashout_locked/);
    expect(gs).not.toMatch(/atomic_credit_wallet_and_log/);
    expect(gs).not.toMatch(/credit_player_wallet/);
  });

  it('the aggregate key that made a retry look like destruction is gone', () => {
    expect(gs).not.toMatch(/startup-cashout:/);
  });

  it('the boot sweep never deletes a seat row', () => {
    // CLAUDE.md 11.5: deleting one skips the refund and destroys the chips.
    expect(gs).not.toMatch(/from\('table_seats'\)[\s\S]{0,200}\.delete\(/);
  });
});
