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
    expect(sites.length).toBeGreaterThanOrEqual(10);
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
          rpc === 'fn_credit_player_wallet_once' && /didCredit|=== false|if \(!\w*[Cc]redit/.test(window),
          `${file}:${i + 1} credits via ${rpc} and then writes a ledger row that is not gated ` +
            `on whether the credit actually happened — the phantom-row shape`
        ).toBe(true);
      });
    });
  }
});

describe('the two table cash-out paths cannot diverge again', () => {
  const seats = stripComments(readFileSync(join(ROOT, 'server/src/services/supabase/seats.ts'), 'utf8'));

  it('markSeatAsLeft and atomicCashout call the SAME rpc', () => {
    const calls = [...seats.matchAll(/rpc\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    const credits = calls.filter((c) => (CREDIT_RPCS as readonly string[]).includes(c));
    expect(credits.length, 'both cash-out paths should credit').toBe(2);
    expect(new Set(credits).size, 'the two paths must use one RPC — they share a key').toBe(1);
    expect(credits[0]).toBe('atomic_credit_wallet_and_log');
  });

  it('both derive their key from cashoutKey(seat)', () => {
    const uses = [...seats.matchAll(/p_idempotency_key:\s*cashoutKey\(seat\)/g)];
    expect(uses.length).toBe(2);
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

  it('boot-time cash-outs write a ledger row like every other cash-out', () => {
    // It used to call credit_player_wallet and log nothing at all: chips
    // appeared in a balance with no wallet_transactions and no
    // chip_transactions row behind them.
    expect(gs).toMatch(/startup-cashout:/);
    const idx = gs.indexOf('startup-cashout:');
    const block = gs.slice(Math.max(0, idx - 1200), idx);
    expect(block).toMatch(/rpc\(\s*'atomic_credit_wallet_and_log'/);
    expect(block).toMatch(/p_category:\s*'cashout'/);
  });
});
