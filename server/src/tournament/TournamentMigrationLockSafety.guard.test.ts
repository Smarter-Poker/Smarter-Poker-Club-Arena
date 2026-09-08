/**
 * The bounty outbox schema and financial-authority switch are one database
 * transaction. This coalesces PostgREST's DDL reload notification and makes
 * every replacement key, function, grant, publication and trigger visible at
 * one commit. The lock timeout bounds acquisition only; rollout drains writers
 * before apply instead of pretending it can bound how long an acquired lock is
 * held.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceSqlStatement } from '../testHelpers/sourceWindow.js';

const SQL = readFileSync(
  join(
    process.cwd(),
    '..',
    'supabase',
    'migrations',
    '20260907180000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
  ),
  'utf8'
);

const transactions = [...SQL.matchAll(/^BEGIN;\n([\s\S]*?)^COMMIT;$/gm)].map((match) => match[1]);

describe('the bounty outbox rollout is one fail-closed authority switch', () => {
  it('uses exactly one transaction and one transaction-local lock timeout', () => {
    expect(transactions).toHaveLength(1);
    expect(SQL.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
    expect(SQL.match(/^SET LOCAL lock_timeout = '250ms';$/gm) ?? []).toHaveLength(1);
    expect(transactions[0]).toMatch(/^SET LOCAL lock_timeout = '250ms';/);
    expect(SQL).not.toMatch(/^SET lock_timeout\s*=/m);
    expect(SQL).not.toMatch(/^RESET lock_timeout;/m);
    expect(SQL).not.toContain('CONCURRENTLY');
    expect(SQL.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('backfills each new invariant before validating it in the same transaction', () => {
    expect(SQL).toMatch(
      /UPDATE public\.tournaments[\s\S]*CHECK \(mystery_bounty_activation_generation>=0\) NOT VALID;[\s\S]*VALIDATE CONSTRAINT tournaments_mystery_activation_generation_nonnegative;/
    );
    expect(SQL).toMatch(
      /FOREIGN KEY \(bounty_obligation_id\)[\s\S]*NOT VALID;[\s\S]*VALIDATE CONSTRAINT tournament_bounties_bounty_obligation_id_fkey;/
    );
    expect(SQL).toMatch(
      /UPDATE public\.tournament_bounty_awards[\s\S]*CHECK \(bounty_obligation_id IS NULL OR activation_generation IS NOT NULL\)[\s\S]*NOT VALID;[\s\S]*VALIDATE CONSTRAINT tournament_bounty_awards_bound_generation_present;/
    );
  });

  it('proves exact replacement indexes before removing legacy uniqueness', () => {
    const replacementIndexes = [
      {
        name: 'uq_tourney_bounty_ko_legacy',
        keys: "ARRAY['tournament_id','eliminated_player_id','collector_player_id']::text[]",
        predicate: 'bounty_obligation_id IS NULL',
      },
      {
        name: 'uq_tourney_bounty_ko_generation',
        keys: "ARRAY['bounty_obligation_id','collector_player_id']::text[]",
        predicate: 'bounty_obligation_id IS NOT NULL',
      },
      {
        name: 'uq_tournament_bounty_award_legacy',
        keys: "ARRAY['tournament_id','eliminated_user_id']::text[]",
        predicate: 'bounty_obligation_id IS NULL',
      },
      {
        name: 'uq_tournament_bounty_award_generation',
        keys: "ARRAY['bounty_obligation_id']::text[]",
        predicate: 'bounty_obligation_id IS NOT NULL',
      },
    ];
    for (const index of replacementIndexes) {
      expect(SQL).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${index.name}`);
      expect(SQL).toContain(`c.relname='${index.name}'`);
      expect(SQL).toContain(`('${index.name}',`);
      expect(SQL).toContain(index.keys);
      expect(SQL).toContain(`'${index.predicate}')`);
    }
    const lastReplacement = Math.max(
      ...replacementIndexes.map((index) =>
        SQL.indexOf(`CREATE UNIQUE INDEX IF NOT EXISTS ${index.name}`)
      )
    );
    expect(lastReplacement).toBeLessThan(
      SQL.indexOf('DROP INDEX IF EXISTS public.uq_tourney_bounty_ko')
    );
    expect(lastReplacement).toBeLessThan(
      SQL.indexOf(
        'DROP CONSTRAINT IF EXISTS tournament_bounty_awards_tournament_id_eliminated_user_id_key'
      )
    );
    expect((SQL.match(/NOT i\.indisvalid/g) ?? []).length).toBe(4);
    for (const catalogProof of [
      'i.indisunique',
      'i.indisvalid',
      'i.indisready',
      "access_method.amname='btree'",
      'i.indnkeyatts=cardinality(v_expected.key_columns)',
      'i.indnatts=cardinality(v_expected.key_columns)',
      'pg_get_indexdef(i.indexrelid,key_position,true)',
      'pg_get_expr(i.indpred,i.indrelid,true)=v_expected.predicate',
    ]) {
      expect(SQL).toContain(catalogProof);
    }
  });

  it('installs trigger authority after compilation and ends at the only commit', () => {
    const lockAt = SQL.indexOf('LOCK TABLE public.tournament_bounties,');
    const tail = SQL.slice(lockAt);
    expect(lockAt).toBeGreaterThan(SQL.lastIndexOf('CREATE OR REPLACE FUNCTION'));
    expect((tail.match(/^DROP TRIGGER/gm) ?? []).length).toBe(9);
    expect((tail.match(/^CREATE TRIGGER/gm) ?? []).length).toBe(9);
    expect(tail).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(tail).not.toMatch(/^UPDATE public\./m);
    expect(tail).not.toMatch(/^INSERT INTO public\./m);
    expect(tail.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('publishes each durable event table exactly once inside the authority transaction', () => {
    for (const table of [
      'tournament_manager_wakes',
      'tournament_bounty_obligations',
      'tournament_deal_votes',
    ]) {
      const statement = `ALTER PUBLICATION supabase_realtime ADD TABLE public.${table}`;
      expect(transactions[0]).toContain(statement);
      expect(SQL.split(statement)).toHaveLength(2);
    }
    expect(transactions[0].match(/ALTER PUBLICATION/g) ?? []).toHaveLength(3);
  });

  it('keeps trigger-only completion and re-entry guards unreachable by every API role', () => {
    for (const guard of [
      'fn_refuse_reentry_with_pending_bounty()',
      'fn_refuse_completed_with_pending_bounties()',
    ]) {
      expect(SQL).toContain(
        `REVOKE ALL ON FUNCTION public.${guard}\n  FROM PUBLIC,anon,authenticated,service_role;`
      );
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(SQL).toContain(`has_function_privilege('${role}','public.${guard}','EXECUTE')`);
      }
    }
  });

  it('removes legacy bounty reconstruction and bounds only the durable outbox drain', () => {
    const sweep = sliceSqlStatement(
      SQL,
      'CREATE OR REPLACE FUNCTION public.fn_sweep_pending_tournament_bounties('
    );
    expect(SQL).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_backfill_legacy_tournament_bounty_obligations(?:_page)?\(/
    );
    expect(SQL).toContain(
      'DROP FUNCTION IF EXISTS public.fn_backfill_legacy_tournament_bounty_obligations(uuid,integer);'
    );
    expect(SQL).toContain(
      'DROP FUNCTION IF EXISTS public.fn_backfill_legacy_tournament_bounty_obligations_page(uuid,integer);'
    );
    expect(sweep).toContain('FROM public.tournament_bounty_obligations bo');
    expect(sweep).toContain("bo.state = 'pending'");
    expect(sweep).toContain('LIMIT v_limit');
    expect(sweep).not.toContain('tournament_players');
    expect(sweep).not.toContain('settlement_idempotency_keys');
    expect(sweep).not.toContain('hand_history');
  });

  it('cannot reclaim the registration wrapper from a later lifecycle migration on ordered replay', () => {
    expect(SQL).toMatch(
      /fn_register_for_tournament_before_atomic_capacity_20260907\(uuid,boolean\)'[\s\S]{0,180}IS NULL[\s\S]{0,180}fn_register_for_tournament_before_atomic_lifecycle_gate\(uuid,boolean\)'[\s\S]{0,80}IS NULL THEN/
    );
    expect(SQL).toMatch(
      /fn_register_for_tournament_before_atomic_lifecycle_gate\(uuid,boolean\)'[\s\S]{0,100}IS NULL THEN\s+EXECUTE v_registration_wrapper;/
    );
    expect(SQL).toContain(
      'ordered migration replay restored a default on the downstream registration lifecycle gate'
    );
    expect(SQL).toContain('IF v_defaults<>0 THEN');
  });
});
