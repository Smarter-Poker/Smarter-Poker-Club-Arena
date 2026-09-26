/**
 * THE LEDGER REPLAY KEYS A UNION WALLET BY ITS UNION (2026-09-26).
 *
 * fn_ca_autoledger stamps a union_wallets leg with the wallet ROW id; a
 * declaring payer stamps the UNION id; fn_ca_account_balance reads the wallet
 * by union_id. Keyed as written, one wallet was two accounts: the union-id half
 * was judged without the Diamond prize legs (-109.14 and -234.10 of "drift" on
 * the Midway promo wallet, 2026-09-21/22, each exactly the prizes it paid), and
 * the row-id half - every autoledgered union bank, rake, promo, BBJ, insurance
 * and spin-reserve movement - could never be read and was silently skipped.
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
const latestDefinitionOf = (fn: string): { file: string; body: string } | null => {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i');
  for (const f of sorted().reverse()) {
    const body = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    if (re.test(body)) return { file: f, body };
  }
  return null;
};
/** The text of one CREATE OR REPLACE FUNCTION ... $function$ block. */
const functionBlock = (sql: string, fn: string): string => {
  const start = sql.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i'));
  expect(start, `${fn} is defined`).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start);
  const close = sql.indexOf('$function$', open + 10);
  return sql.slice(start, close + 10);
};

const M = migrationNamed('the_ledger_replay_keys_a_union_wallet_by_its_union');

describe('the ledger replay keys a union wallet by its union', () => {
  for (const fn of ['fn_ca_leg_accounts', 'fn_ca_leg_accounts_since_snapshot']) {
    it(`${fn} maps a union_wallets row id to its union for union_wallet and union_bank legs`, () => {
      const block = functionBlock(M, fn);
      expect(block).toContain("WHEN s.t IN ('union_wallet', 'union_bank')");
      expect(block).toContain(
        'THEN COALESCE((SELECT w.union_id FROM public.union_wallets w WHERE w.id = s.id), s.id)'
      );
      expect(block).toContain('OR EXISTS (SELECT 1 FROM public.union_wallets w WHERE w.id = s.id)');
    });

    it(`the newest ${fn} on disk still keys union wallets by their union`, () => {
      const live = latestDefinitionOf(fn);
      expect(live).not.toBeNull();
      expect(
        functionBlock(live!.body, fn),
        `${live!.file} redefines ${fn} without the union keying`
      ).toContain('SELECT w.union_id FROM public.union_wallets w WHERE w.id = s.id');
    });
  }

  it('guards the pre-image and restates the explicit service_role grant', () => {
    expect(M).toContain("'5f1a5e9507b9c9c11ae61b41fd842eaa'");
    expect(M).toContain("'05378ace9b11c3200a060458460d6f57'");
    expect(M).toContain('{postgres=X/postgres,service_role=X/postgres}');
    expect(M).toMatch(/GRANT EXECUTE ON FUNCTION public\.fn_ca_leg_accounts\(timestamptz, timestamptz\) TO service_role/);
    expect(M).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_leg_accounts_since_snapshot\(timestamptz, pg_snapshot\) TO service_role/
    );
  });

  it('proves after the swap that no account is keyed by a wallet row', () => {
    expect(M).toContain('WHERE a.entity_id IN (SELECT w.id FROM public.union_wallets w)');
    expect(M).toContain('are still keyed by a union_wallets row');
  });

  it('the balance reader it relies on still reads every union wallet by union_id', () => {
    const live = latestDefinitionOf('fn_ca_account_balance');
    if (live) {
      expect(live.body).toMatch(/union_wallets\.promo_wallet'[\s\S]*FROM public\.union_wallets WHERE union_id = p_entity/);
    }
  });
});
