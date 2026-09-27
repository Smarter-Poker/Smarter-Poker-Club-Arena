import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260927042756_certification_cleanup_removes_five_prearchive_public_user_residue.sql'
  ),
  'utf8'
);

const exactRows = [
  {
    id: '27d04334-7317-4594-a132-24e7a9b40422',
    email:
      'ca-customization-cert-bundle-1788163733536-b39cfc17-4931-4197-b7d8-42ccc8a9706d@example.invalid',
    username: 'Certbundc8a9706',
    timestamp: '2026-08-31T08:08:53.875389Z',
  },
  {
    id: '51511e89-f48f-49be-b89a-f5f47ce681db',
    email:
      'ca-customization-cert-buyer-1788163730335-e62b39f0-87a2-4df0-aec5-9b5fee205363@example.invalid',
    username: 'Certbuyeee20536',
    timestamp: '2026-08-31T08:08:50.679143Z',
  },
  {
    id: '60c13392-aebb-486e-86fb-9db3d2424a8a',
    email:
      'ca-customization-cert-bundle-1788179589362-144cd324-9904-4be7-b838-821f02616dcc@example.invalid',
    username: 'Certbund02616dc',
    timestamp: '2026-08-31T12:33:09.542752Z',
  },
  {
    id: '7642a424-6111-45ca-898a-1e20180930d2',
    email:
      'ca-customization-cert-observer-1788163735780-4a1660cc-66f7-4116-a875-19adb406c26f@example.invalid',
    username: 'Certobseb406c26',
    timestamp: '2026-08-31T08:08:56.032708Z',
  },
  {
    id: '8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a',
    email:
      'ca-customization-cert-observer-1788182591387-e54338f8-4f35-49d1-829d-a776a331a933@example.invalid',
    username: 'Certobsea331a93',
    timestamp: '2026-08-31T13:23:11.819467Z',
  },
];

describe('pre-archive certification public-user residue cleanup', () => {
  it('is one forward transaction, refuses a freeze, and does not widen the cleanup RPC', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*\nBEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain("SET LOCAL statement_timeout = '15min'");
    expect(migration).not.toContain('SET LOCAL max_parallel_workers_per_gather');
    expect(migration).toContain('IF public.fn_platform_frozen() THEN');
    expect(migration).toContain(
      'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_REFUSES_PLATFORM_FREEZE'
    );
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
  });

  it('pins all five public-user preimages by id, email, username, null avatar, and timestamps', () => {
    for (const row of exactRows) {
      expect(migration).toContain(row.id);
      expect(migration).toContain(row.email);
      expect(migration).toContain(`'${row.username}'::text`);
      expect(migration).toContain(row.timestamp);
    }
    expect(migration.match(/NULL::text/g)).toHaveLength(10);
    expect(migration).toContain('u.email = v_row.email');
    expect(migration).toContain('u.username = v_row.username');
    expect(migration).toContain('u.avatar_url IS NOT DISTINCT FROM v_row.avatar_url');
    expect(migration).toContain('u.username = expected.username');
    expect(migration).toContain('u.avatar_url IS NOT DISTINCT FROM expected.avatar_url');
    expect(migration).toContain('u.created_at = v_row.created_at');
    expect(migration).toContain('u.updated_at = v_row.updated_at');
    expect(migration).toContain('v_deleted <> 5');
    expect(migration).not.toContain('a28421ff-9f27-4a99-81dd-2e18884d616c');
  });

  it('refuses newly appeared archive, identity, custody, journal, and asset surfaces', () => {
    for (const refusal of [
      'public.ca_test_account_audit_archive a WHERE a.actor_id = v_row.id',
      'public.ca_test_account_ledger_actor_archive l WHERE l.actor_id = v_row.id',
      'auth.users WHERE id = v_row.id',
      'auth.sessions WHERE user_id::text = v_row.id::text',
      'auth.refresh_tokens WHERE user_id::text = v_row.id::text',
      'public.profiles WHERE id = v_row.id',
      'public.club_members WHERE user_id = v_row.id',
      'public.clubs WHERE owner_id = v_row.id',
      'public.unions WHERE owner_id = v_row.id',
      'public.agents WHERE user_id = v_row.id',
      'public.table_seats WHERE user_id = v_row.id',
      'public.tournament_players WHERE user_id = v_row.id',
      'public.wallets WHERE user_id = v_row.id',
      'public.wallet_transactions WHERE user_id = v_row.id',
      'public.wallet_credit_idempotency WHERE user_id = v_row.id',
      'public.diamond_wallets WHERE user_id = v_row.id',
      'public.diamond_transactions WHERE user_id = v_row.id',
      'public.chip_ledger WHERE performed_by = v_row.id',
      'public.audit_trail WHERE actor_id = v_row.id',
      'public.accounting_invoice_deliveries WHERE recipient_id = v_row.id',
      'public.push_outbox WHERE recipient_user_id = v_row.id',
      'public.signup_errors e WHERE e.user_id = v_row.id',
      'public.client_shell_telemetry WHERE user_id = v_row.id',
      'public.vip_points WHERE user_id = v_row.id',
      'public.vip_points_carry WHERE user_id = v_row.id',
      'public.vip_points_ledger WHERE user_id = v_row.id',
      'public.session_history WHERE user_id = v_row.id',
      'public.player_position_stats WHERE user_id = v_row.id',
      'public.user_feedback WHERE user_id = v_row.id',
      'public.throw_usage WHERE user_id = v_row.id',
      'public.special_bonuses WHERE user_id = v_row.id',
      'public.user_daily_rewards WHERE user_id = v_row.id',
      'public.promotion_claims WHERE user_id = v_row.id',
      'public.referral_codes WHERE user_id = v_row.id',
      'public.referral_redemptions',
      'referrer_id = v_row.id OR referee_id = v_row.id',
      'public.referral_milestone_claims WHERE user_id = v_row.id',
      "to_regclass('public.user_bonuses') IS NOT NULL",
      "o.bucket_id = 'club-assets'",
      "o.name LIKE 'club-logos/' || v_row.id::text || '%'",
    ]) {
      expect(migration).toContain(refusal);
    }
    expect(
      migration.indexOf('PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY')
    ).toBeLessThan(migration.indexOf('DELETE FROM public.users u'));
  });

  it('catalog-checks every extant no-FK UUID user surface and mutates only after validation', () => {
    for (const contract of [
      'FROM pg_catalog.pg_class c',
      'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
      'JOIN pg_catalog.pg_attribute a',
      "a.atttypid = 'uuid'::regtype",
      "a.attname = 'user_id'",
      "a.attname LIKE '%\\_user\\_id' ESCAPE '\\'",
      "a.attname LIKE '%\\_by' ESCAPE '\\'",
      "'challenger_id', 'challengee_id'",
      "'caller_id', 'callee_id', 'caller_uid', 'jwt_sub'",
      'FROM pg_catalog.pg_constraint fk',
      "fk.contype = 'f'",
      'a.attnum = ANY (fk.conkey)',
      "('signup_errors', 'user_id')",
      "('rakeback_stats_applied', 'user_id')",
      "'SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I = ANY ($1))'",
    ]) {
      expect(migration).toContain(contract);
    }

    const lastValidation = migration.lastIndexOf(
      'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY'
    );
    expect(lastValidation).toBeGreaterThan(-1);
    expect(lastValidation).toBeLessThan(migration.indexOf('DELETE FROM public.users u'));
  });

  it('guards the unindexed ten-million-row rakeback surface with a bounded parallel count', () => {
    const parallelStart = migration.indexOf(
      "set_config('max_parallel_workers_per_gather', '8', true)"
    );
    const rakebackCount = migration.indexOf('FROM public.rakeback_stats_applied r');
    const parallelRestore = migration.indexOf(
      "set_config('max_parallel_workers_per_gather', v_old_max_parallel, true)"
    );
    const catalogLoop = migration.indexOf('FOR v_surface IN');
    expect(migration).toContain('FROM public.rakeback_stats_applied r');
    expect(migration).toContain('WHERE r.user_id = ANY (v_target_ids)');
    expect(migration).toContain('IF v_rakeback_rows <> 0 THEN');
    expect(migration).toContain(
      'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY: rakeback_stats_applied.user_id'
    );
    expect(migration.indexOf('FROM public.rakeback_stats_applied r')).toBeLessThan(
      migration.indexOf('DELETE FROM public.users u')
    );
    expect(parallelStart).toBeGreaterThan(-1);
    expect(parallelStart).toBeLessThan(rakebackCount);
    expect(rakebackCount).toBeLessThan(parallelRestore);
    expect(parallelRestore).toBeLessThan(catalogLoop);
    for (const setting of [
      'max_parallel_workers_per_gather',
      'min_parallel_table_scan_size',
      'parallel_setup_cost',
      'parallel_tuple_cost',
    ]) {
      expect(migration).toContain(`current_setting('${setting}')`);
    }
  });

  it('refuses a changed public-users delete graph before the first mutation', () => {
    const graphRefusal = migration.indexOf(
      'PREARCHIVE_CERTIFICATION_PUBLIC_USER_DELETE_GRAPH_CHANGED'
    );
    expect(migration).toContain("t.tgrelid = 'public.users'::regclass");
    expect(migration).toContain('AND NOT t.tgisinternal');
    expect(migration).toContain("fk.contype = 'f'");
    expect(migration).toContain("fk.confrelid = 'public.users'::regclass");
    expect(graphRefusal).toBeGreaterThan(-1);
    expect(graphRefusal).toBeLessThan(migration.indexOf('DELETE FROM public.users u'));
  });

  it('deletes only the five exact shadows', () => {
    expect(migration).not.toContain('DELETE FROM public.signup_errors');
    expect(migration).toContain('DELETE FROM public.users u');
    expect(migration).not.toMatch(
      /DELETE FROM (?:auth\.users|public\.profiles|public\.clubs|public\.wallets|public\.chip_ledger)/
    );
    expect(migration).not.toMatch(/DELETE FROM public\.users\s+WHERE\s+email\s+LIKE/i);
    expect(migration).toContain('PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_DELETE_COUNT');
  });
});
