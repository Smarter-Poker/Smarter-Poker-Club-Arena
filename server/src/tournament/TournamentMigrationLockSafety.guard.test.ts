/**
 * The bounty outbox migration lands while tournament rows are continuously
 * written. A hot table lock must therefore be fail-fast and must never span a
 * row rewrite or function-compilation phase.
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

describe('the bounty outbox rollout never parks an active tournament table', () => {
  it('uses only explicit 250 ms transaction-local lock windows', () => {
    expect(transactions.length).toBeGreaterThan(10);
    for (const transaction of transactions) {
      expect(transaction).toMatch(/^SET LOCAL lock_timeout = '250ms';/);
    }
    expect(SQL).not.toMatch(/lock_timeout\s*=\s*'10s'/);
  });

  it('keeps existing-table schema locks out of row-rewrite and compilation transactions', () => {
    const hotSchemaTransactions = transactions.filter((transaction) =>
      /ALTER TABLE public\.(?:tournaments|tournament_bounties|tournament_bounty_awards)/.test(
        transaction
      )
    );
    expect(hotSchemaTransactions.length).toBeGreaterThan(0);
    for (const transaction of hotSchemaTransactions) {
      expect(transaction).not.toContain('CREATE OR REPLACE FUNCTION');
      expect(transaction).not.toMatch(/^UPDATE public\./m);
    }

    expect(SQL).toMatch(
      /CHECK \(mystery_bounty_activation_generation>=0\) NOT VALID;[\s\S]*COMMIT;[\s\S]*VALIDATE CONSTRAINT tournaments_mystery_activation_generation_nonnegative;/
    );
    expect(SQL).toMatch(
      /FOREIGN KEY \(bounty_obligation_id\)[\s\S]*NOT VALID;[\s\S]*COMMIT;[\s\S]*VALIDATE CONSTRAINT tournament_bounties_bounty_obligation_id_fkey;/
    );
    expect(SQL).toMatch(
      /CHECK \(bounty_obligation_id IS NULL OR activation_generation IS NOT NULL\)[\s\S]*NOT VALID;[\s\S]*COMMIT;[\s\S]*VALIDATE CONSTRAINT tournament_bounty_awards_bound_generation_present;/
    );
  });

  it('builds replacement uniqueness concurrently before removing legacy uniqueness', () => {
    const concurrentIndexes = [
      'uq_tourney_bounty_ko_legacy',
      'uq_tourney_bounty_ko_generation',
      'uq_tournament_bounty_award_legacy',
      'uq_tournament_bounty_award_generation',
    ];
    for (const index of concurrentIndexes) {
      expect(SQL).toContain(
        `SET lock_timeout = '250ms';\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${index}`
      );
      expect(SQL).toContain(`c.relname='${index}'`);
    }
    expect(
      SQL.indexOf('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_tourney_bounty_ko_legacy')
    ).toBeLessThan(SQL.indexOf('DROP INDEX IF EXISTS public.uq_tourney_bounty_ko'));
    expect(
      SQL.indexOf(
        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_tournament_bounty_award_legacy'
      )
    ).toBeLessThan(
      SQL.indexOf(
        'DROP CONSTRAINT IF EXISTS tournament_bounty_awards_tournament_id_eliminated_user_id_key'
      )
    );
    expect((SQL.match(/NOT i\.indisvalid/g) ?? []).length).toBe(4);
  });

  it('acquires all trigger locks only after compilation and commits immediately', () => {
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

  it('publishes each durable event table in its own short boundary', () => {
    for (const table of [
      'tournament_manager_wakes',
      'tournament_bounty_obligations',
      'tournament_deal_votes',
    ]) {
      const owner = transactions.find((transaction) =>
        transaction.includes(`ALTER PUBLICATION supabase_realtime ADD TABLE public.${table}`)
      );
      expect(owner).toBeDefined();
      expect(owner).not.toContain('CREATE OR REPLACE FUNCTION');
      expect((owner?.match(/ALTER PUBLICATION/g) ?? []).length).toBe(1);
    }
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
