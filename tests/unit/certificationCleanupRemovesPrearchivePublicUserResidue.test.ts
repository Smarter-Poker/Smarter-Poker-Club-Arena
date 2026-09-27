import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260927042756_certification_cleanup_removes_six_prearchive_public_user_residue.sql'
  ),
  'utf8'
);

const exactRows = [
  {
    id: '27d04334-7317-4594-a132-24e7a9b40422',
    email:
      'ca-customization-cert-bundle-1788163733536-b39cfc17-4931-4197-b7d8-42ccc8a9706d@example.invalid',
    timestamp: '2026-08-31T08:08:53.875389Z',
  },
  {
    id: '51511e89-f48f-49be-b89a-f5f47ce681db',
    email:
      'ca-customization-cert-buyer-1788163730335-e62b39f0-87a2-4df0-aec5-9b5fee205363@example.invalid',
    timestamp: '2026-08-31T08:08:50.679143Z',
  },
  {
    id: '60c13392-aebb-486e-86fb-9db3d2424a8a',
    email:
      'ca-customization-cert-bundle-1788179589362-144cd324-9904-4be7-b838-821f02616dcc@example.invalid',
    timestamp: '2026-08-31T12:33:09.542752Z',
  },
  {
    id: '7642a424-6111-45ca-898a-1e20180930d2',
    email:
      'ca-customization-cert-observer-1788163735780-4a1660cc-66f7-4116-a875-19adb406c26f@example.invalid',
    timestamp: '2026-08-31T08:08:56.032708Z',
  },
  {
    id: '8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a',
    email:
      'ca-customization-cert-observer-1788182591387-e54338f8-4f35-49d1-829d-a776a331a933@example.invalid',
    timestamp: '2026-08-31T13:23:11.819467Z',
  },
  {
    id: 'a28421ff-9f27-4a99-81dd-2e18884d616c',
    email:
      'ca-customization-cert-postdeploy-1788659737460-da18c019-9c82-45d6-9fa1-d5e5a98f2a10@example.invalid',
    timestamp: '2026-09-06T01:55:37.703383Z',
  },
];

describe('pre-archive certification public-user residue cleanup', () => {
  it('is one forward transaction, refuses a freeze, and does not widen the cleanup RPC', () => {
    expect(migration.trimStart()).toMatch(/^--[\s\S]*\nBEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(migration).toContain('IF public.fn_platform_frozen() THEN');
    expect(migration).toContain(
      'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_REFUSES_PLATFORM_FREEZE'
    );
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
  });

  it('pins all six public-user preimages by id, email, and both timestamps', () => {
    for (const row of exactRows) {
      expect(migration).toContain(row.id);
      expect(migration).toContain(row.email);
      expect(migration).toContain(row.timestamp);
    }
    expect(migration).toContain('u.email = v_row.email');
    expect(migration).toContain('u.created_at = v_row.created_at');
    expect(migration).toContain('u.updated_at = v_row.updated_at');
    expect(migration).toContain('v_deleted <> 6');
  });

  it('pins the one freeze diagnostic by every stable byte identity', () => {
    expect(migration).toContain('e.id = 9105');
    expect(migration).toContain("e.trigger_name = 'handle_new_user_v2_create_wallet'");
    expect(migration).toContain("e.error_code = '55006'");
    expect(migration).toContain("e.occurred_at = '2026-09-06T01:55:37.703383Z'");
    expect(migration).toContain("e.forwarded_to_sentry = '2026-09-06T02:00:37.028Z'");
    expect(migration).toContain('e.raw_meta IS NULL');
    expect(migration).toContain('length(e.error_msg) = 132');
    expect(migration).toContain("md5(e.error_msg) = '7d0f88ba3a6d0777977b4dce80dc072a'");
    expect(migration).toContain('v_signup_deleted <> 1');
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
      'public.signup_errors WHERE user_id = v_row.id',
      'public.client_shell_telemetry WHERE user_id = v_row.id',
      "o.bucket_id = 'club-assets'",
      "o.name LIKE 'club-logos/' || v_row.id::text || '%'",
    ]) {
      expect(migration).toContain(refusal);
    }
    expect(
      migration.indexOf('PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY')
    ).toBeLessThan(migration.indexOf('DELETE FROM public.users u'));
  });

  it('deletes only the six exact shadows and their one exact diagnostic', () => {
    expect(migration).toContain('DELETE FROM public.signup_errors e');
    expect(migration).toContain('DELETE FROM public.users u');
    expect(migration).not.toMatch(
      /DELETE FROM (?:auth\.users|public\.profiles|public\.clubs|public\.wallets|public\.chip_ledger)/
    );
    expect(migration).not.toMatch(/DELETE FROM public\.users\s+WHERE\s+email\s+LIKE/i);
    expect(migration).toContain('PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_DELETE_COUNT');
  });
});
