/**
 * A FENCED GENERATION MAY READ ITS OWN TIME BANK RECEIPT (2026-10-03)
 *
 * The 16:35Z Postgres restart lost the answer to time-bank debit 6b1de5d5
 * (spin 20a7de08, table 9aa37b13). The receipt had committed, but the engine
 * re-asked under its dead manager's lease and the request hook fenced every
 * re-ask. The flag never cleared, the stopped custody was never written, the
 * manager's stop failed once a minute and stopped_bank_custody_stuck held the
 * restart certificate shut, which blocked the release that fixes the re-ask.
 *
 * 20261003185214 lets exactly one more shape past the fence, a POST to
 * rpc/fn_consume_time_bank under its own marker, and fn_consume_time_bank
 * answers that marker only from an existing receipt. This law pins both
 * halves, the digests, and that nothing else changed.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20261003185214_a_fenced_generation_may_read_its_own_time_bank_receipt.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const D = {
  pre_post: '0c47f87ec4ecfdd5de66308604e92b27',
  pre_def_post: '6027b488b1c77d03642b3d384f275d6a',
  ctb_post: 'b67aabf0a73b754a87f5684de3d68b51',
  ctb_def_post: 'f7b9218b8ee0413fd042f9c8491d5b07',
};
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(tag: string): string {
  const open = SQL.indexOf(`AS ${tag}`) + `AS ${tag}`.length;
  const close = SQL.indexOf(tag, open);
  expect(close).toBeGreaterThan(open);
  return SQL.slice(open, close);
}
const HOOK = body('$fenced_receipt_hook$');
const CONSUME = body('$fenced_receipt_consume$');

function passages(): [string, string][] {
  const check = SQL.slice(SQL.indexOf('DO $fenced_receipt_postimage$'));
  const quoted = [...check.matchAll(/\$r\$([\s\S]*?)\$r\$/g)].map((m) => m[1]);
  expect(quoted.length).toBe(4);
  return [
    [quoted[0], quoted[1]],
    [quoted[2], quoted[3]],
  ];
}

describe('a fenced generation may read its own time bank receipt', () => {
  it('installs the stated bodies over the inspected pre-images', () => {
    expect(md5(HOOK)).toBe(D.pre_post);
    expect(md5(CONSUME)).toBe(D.ctb_post);
    for (const digest of [
      '0e6038e3ddf79a4e82f401c41f2a55da',
      '4014592d136fe1dcd1ba5c88492d5c92',
      '6adbdcd86c910c09e56b4f10193d2e55',
      'e8e37336d62cf26b98d310472e0a5f94',
      D.pre_def_post,
      D.ctb_def_post,
    ])
      expect(SQL).toContain(digest);
  });

  it('changes one passage of each body, and restoring them reproduces the pre-images', () => {
    const [[hookNow, hookBefore], [consumeNow, consumeBefore]] = passages();
    expect(HOOK.split(hookNow).length).toBe(2);
    expect(CONSUME.split(consumeNow).length).toBe(2);
    expect(md5(HOOK.replace(hookNow, hookBefore))).toBe('0e6038e3ddf79a4e82f401c41f2a55da');
    expect(md5(CONSUME.replace(consumeNow, consumeBefore))).toBe(
      '6adbdcd86c910c09e56b4f10193d2e55'
    );
  });

  it('admits only a POST to rpc/fn_consume_time_bank, under its own marker, after the lease check failed', () => {
    const fenced = HOOK.slice(HOOK.indexOf('IF NOT FOUND THEN'));
    expect(fenced).toContain(
      "IF v_method = 'POST' AND v_path = 'rpc/fn_consume_time_bank' THEN\n      PERFORM set_config('app.smarter_data_actor', 'fenced-manager-time-bank-receipt', true);"
    );
    expect(HOOK.split("'fenced-manager-time-bank-receipt'").length).toBe(2);
    expect(HOOK).toContain(
      "PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);"
    );
    expect(HOOK).toContain('FOR KEY SHARE');
  });

  it('answers the marker only from a committed receipt; otherwise it is fenced before any lock or write', () => {
    const replay = CONSUME.indexOf(
      "RETURN v_receipt || jsonb_build_object('idempotent_replay', true);"
    );
    const gate = CONSUME.indexOf(
      "IF current_setting('app.smarter_data_actor', true) = 'fenced-manager-time-bank-receipt' THEN\n    RAISE EXCEPTION 'TOURNAMENT_MANAGER_FENCED"
    );
    const lock = CONSUME.indexOf('PERFORM pg_advisory_xact_lock(');
    expect(replay).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(replay);
    expect(lock).toBeGreaterThan(gate);
    expect(CONSUME.slice(0, gate)).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('is one transaction with no grant, and the newest definition of both functions', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).not.toMatch(/^GRANT /m);
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) => {
        const t = readFileSync(join(MIGRATIONS, f), 'utf8');
        return (
          t.includes('FUNCTION smarter_private.fn_smarter_data_api_pre_request(') ||
          t.includes('FUNCTION public.fn_consume_time_bank(')
        );
      });
    expect(later).toEqual([]);
  });
});
