/**
 * LAW: THE MINT REGISTER KEEPS ITS SUPPLY IN SHARDS (2026-10-03).
 *
 * fn_ca_register_issuance_leg filled supply_after by summing every chips row
 * of ca_mint_ledger, inside the commit of every hand that raked: 0.67 s and
 * 19,286 buffers per call on 822,498 rows, 65,000 calls a day, and growing
 * with every row it wrote. The same signed total now lives in
 * ca_mint_supply_shards (32 rows per asset), moved by statement-level
 * triggers from their transition tables, one shard per transaction.
 *
 * What this pins: the register reads the shards, never the whole register;
 * the shards are kept by insert, update and delete triggers with the same
 * sign rule; the seed is taken under a lock that no register row can slip
 * past; the migration refuses to commit unless shards and register agree;
 * and the disposable-cluster harness proves the same supply_after row for
 * row against the production pre-image.
 * scripts/ci/test-the-mint-register-keeps-its-supply-in-shards.py
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { migrationCorpus } from './helpers/migrationCorpus';

const FILE = '20261003220304_the_mint_register_keeps_its_supply_in_shards.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');
const PRE = readFileSync(
  resolve(process.cwd(), 'scripts/ci/fixtures/mint-supply-shards/fn_ca_register_issuance_leg.pre.sql'),
  'utf8'
);

function declaration(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_register_issuance_leg(');
  expect(start, 'the register is declared').toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start)) + '$function$\n';
}

function newestFile(): string {
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?fn_ca_register_issuance_leg\s*\(/i;
  let hit = '';
  for (const m of migrationCorpus()) if (re.test(m.sql)) hit = m.name;
  return hit;
}

const FN = declaration(MIG);

describe('the mint register keeps its supply in shards', () => {
  it('is one pinned transaction written against the production pre-image', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    expect(createHash('md5').update(PRE).digest('hex')).toBe('8d3d5e1feccd96fcf0045afefdb9fcdc');
    expect(MIG).toContain("IS DISTINCT FROM '8d3d5e1feccd96fcf0045afefdb9fcdc'");
    const md5 = createHash('md5').update(FN).digest('hex');
    expect(md5).toBe('ddf442eda21e107d2aa9f525e2c64f21');
    expect(MIG).toContain(`= '${md5}')`);
    // Only the supply read changes: the rest of the function is the pre-image.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    const pre = strip(PRE).replace(
      /SELECT COALESCE\(SUM\(CASE WHEN action = 'mint' THEN amount ELSE -amount END\), 0\)[\s\S]*?WHERE asset = 'chips';/,
      'SUPPLY'
    );
    const now = strip(FN).replace(
      /SELECT COALESCE\(SUM\(s\.net\), 0\)[\s\S]*?WHERE s\.asset = 'chips';/,
      'SUPPLY'
    );
    expect(now.replace(/\s+/g, ' ')).toBe(pre.replace(/\s+/g, ' '));
  });

  it('reads the shards and never sums the whole register', () => {
    const code = FN.replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(code).toContain('FROM public.ca_mint_supply_shards s WHERE s.asset = \'chips\'');
    expect(code).not.toMatch(/SUM\(CASE WHEN action = 'mint'[\s\S]*FROM public\.ca_mint_ledger WHERE asset/);
  });

  it('keeps the shards on insert, update and delete with the same sign rule, one shard per transaction', () => {
    for (const t of ['INSERT', 'UPDATE', 'DELETE'])
      expect(MIG).toMatch(new RegExp(`AFTER ${t} ON public\\.ca_mint_ledger\\s+REFERENCING[^;]*FOR EACH STATEMENT`));
    expect(MIG).toContain("(((hashtext(txid_current()::text) % 32) + 32) % 32)::smallint");
    expect(MIG.match(/CASE WHEN [no]\.action = 'mint' THEN [no]\.amount ELSE -[no]\.amount END/g)?.length).toBe(4);
    expect(MIG).toContain('ON CONFLICT (asset, shard) DO UPDATE SET net = s.net + EXCLUDED.net;');
  });

  it('seeds under a lock no register row can pass, and refuses to commit unless they agree', () => {
    const lock = MIG.indexOf('LOCK TABLE public.ca_mint_ledger IN SHARE ROW EXCLUSIVE MODE;');
    const seed = MIG.indexOf('INSERT INTO public.ca_mint_supply_shards (asset, shard, net)');
    const trig = MIG.indexOf('CREATE TRIGGER trg_ca_mint_supply_shard_insert');
    expect(lock).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(lock);
    expect(trig).toBeGreaterThan(seed);
    expect(MIG).toContain('SUPPLY_SHARDS_DO_NOT_AGREE_WITH_THE_REGISTER');
    expect(MIG).toContain('REVOKE ALL ON TABLE public.ca_mint_supply_shards FROM PUBLIC, anon, authenticated;');
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.fn_ca_register_issuance_leg(uuid) FROM PUBLIC, anon, authenticated;');
    expect(MIG).not.toMatch(/REFERENCES\s+public\./i);
    expect(newestFile()).toBe(FILE);
  });

  it('ships the disposable-cluster proof', () => {
    expect(
      existsSync(join(process.cwd(), 'scripts', 'ci', 'test-the-mint-register-keeps-its-supply-in-shards.py'))
    ).toBe(true);
  });
});
