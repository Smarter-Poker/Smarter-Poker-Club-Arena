import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const base = 'scripts/ci/fixtures/tournament-cancellation-lane/';
const migration =
  'supabase/migrations/20261030004352_tournament_cancellation_keeps_unrelated_hands_in_their_own_l.sql';
const helper = read(base + 'admission.sql');

describe('Cancellation cannot queue an exclusive lane ahead of hand readers', () => {
  it('enforces the real PostgreSQL regression in required accounting qualification', () => {
    const ci = parse(read('.github/workflows/ci.yml'));
    const steps = ci.jobs.accounting_postgres.steps;
    const lane = steps.filter((step: { run?: string }) =>
      step.run?.includes('test-tournament-cancellation-lane.py')
    );
    expect(lane).toHaveLength(1);
    expect(lane[0].if).toBe('matrix.shard == 4');
    expect(lane[0]['continue-on-error']).toBeUndefined();
    expect(lane[0].run).toContain('--pg-bin /usr/lib/postgresql/17/bin');
    expect(lane[0].run).not.toContain('--admission-only');
    for (const input of [
      migration,
      base + 'admission.sql',
      base + 'preimages.json',
      'scripts/ci/test-tournament-cancellation-lane.py',
    ]) {
      expect(classifyChangedPaths([input]).server).toBe(true);
      expect(classifyChangedPaths([input]).tests).toBe(true);
    }
  });

  it('uses one nonblocking admission for each original exclusive lane', () => {
    expect(helper.match(/pg_try_advisory_xact_lock\(g\)/g)).toHaveLength(1);
    expect(helper.match(/pg_try_advisory_xact_lock\(b\)/g)).toHaveLength(1);
    expect(helper).not.toMatch(/\bpg_advisory_xact_lock(?:_shared)?\s*\(/);
    expect(helper).not.toMatch(/\bset_config\s*\(/);
    expect(helper).toContain("ERRCODE='55P03'");
    expect(read(migration)).toContain(helper);
  });

  it('preserves existing sweep authority and limits the doctrine exception to exact catalog identity', () => {
    expect(helper).toContain("IF NOT gs OR NOT fx OR scope<>'' THEN");
    expect(helper).toContain('held<>p_tournament_id::text OR NOT prior_t');
    const before = JSON.parse(read(base + 'doctrine.json'));
    const after = JSON.parse(read(base + 'doctrine-postimage.json'));
    expect(createHash('md5').update(before.definition).digest('hex')).toBe(before.definition_md5);
    expect(createHash('md5').update(after.definition).digest('hex')).toBe(after.definition_md5);
    const addition = after.definition.slice(
      after.definition.indexOf('\n     -- Only this exact owner-only observer'),
      after.definition.indexOf('\n  IF v_set IS DISTINCT FROM\n')
    );
    expect(addition).toContain("to_regprocedure('smarter_private.cancellation_lane(uuid)')");
    expect(addition).toContain("md5(pg_get_functiondef(p.oid))='bc4f86f56d7349416264a237817969b2'");
    expect(addition).toContain("p.proowner='postgres'::regrole");
    expect(addition).toContain("p.proacl::text='{postgres=X/postgres}'");
    expect(addition).toContain('AND NOT p.prosecdef,false);');
    expect(after.definition.replace(addition, ';')).toBe(before.definition);
    expect(read(migration)).toContain(after.definition_md5);
  });

  it('retains full financial bodies behind the four reviewed entry prefixes', () => {
    const before = JSON.parse(read(base + 'preimages.json'));
    const after = JSON.parse(read(base + 'postimages.json'));
    const old = 'PERFORM public.fn_ca_lock_settlement_lane_global();';
    expect(Object.keys(after)).toHaveLength(4);
    for (const row of before.filter((row: { signature: string }) => row.signature in after)) {
      const replacement = row.signature.startsWith('fn_close_managed_game(')
        ? 'IF p_game_id IS NOT NULL THEN PERFORM smarter_private.cancellation_lane(p_game_id); END IF;'
        : 'PERFORM smarter_private.cancellation_lane(p_tournament_id);';
      expect(row.definition.split(old)).toHaveLength(2);
      const post = row.definition.replace(old, replacement);
      expect(createHash('md5').update(post).digest('hex')).toBe(after[row.signature]);
      expect(read(migration)).toContain(after[row.signature]);
    }
  });
});
