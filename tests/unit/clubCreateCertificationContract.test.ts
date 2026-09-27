import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Create Club production certification contract', () => {
  it('uses the exact disposable prefix accepted by the retirement RPC and lifecycle guard', () => {
    const spec = read('tests/e2e/production-create-club.spec.ts');
    const cleanup = read('scripts/ci/production-e2e-account.mjs');
    const retire = read(
      'supabase/migrations/20260903230339_a_certification_club_is_retired_to_the_mint_and_then_it_is_gone.sql'
    );
    const lifecycle = read(
      'supabase/migrations/20260906091646_cashier_requests_and_membership_deletes_are_server_owned.sql'
    );

    expect(spec).toContain('`Crest Cert ${stamp}`');
    expect(cleanup).toContain("startsWith('Crest Cert ')");
    expect(retire).toContain("v_club.name NOT LIKE 'Crest Cert %'");
    expect(lifecycle).toContain("OLD.name LIKE 'Crest Cert %'");
    expect(spec).not.toContain('Club Create Cert ');
    expect(cleanup).not.toContain('Club Create Cert ');
  });

  it('retires the exact shared UI fixture namespace before account cleanup', () => {
    const account = read('scripts/ci/production-e2e-account.mjs');
    const migration = read(
      'supabase/migrations/20260926220210_create_club_ui_certificate_cleanup_accepts_its_reserved_account.sql'
    );

    expect(account).toContain("const ACCOUNT_SUFFIX = '@example.invalid'");
    expect(migration).toContain("md5(v_old) <> 'a932ec8f2f18d186499f4118e2f582b4'");
    expect(migration).toContain("LIKE 'ca-customization-cert-postdeploy-%@example.invalid'");
    expect(migration).toContain(
      'CREATE_CLUB_CERT_RETIRE_PATCH_DID_NOT_PRODUCE_ONE_RESERVED_NAMESPACE'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_retire_certification_club(uuid, text)'
    );
  });

  it('runs only after publication and proves both endpoints serve its exact checked-out SHA', () => {
    const workflow = read('.github/workflows/club-create-certification.yml');

    expect(workflow).toContain("workflows: ['Publish Club Arena']");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).not.toMatch(/^\s{2}push:/m);
    expect(workflow).toContain('expected="$(git rev-parse HEAD)"');
    expect(workflow).toContain('https://ca-static.smarter.poker/build-info.json');
    expect(workflow).toContain('https://smarter.poker/hub/club-arena/build-info.json');
    expect(workflow).toContain('production-e2e-provenance.mjs build-info');
    expect(workflow).toContain('"$origin_sha" == "$expected"');
    expect(workflow).toContain('"$public_sha" == "$expected"');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 30');
    expect(workflow).toContain('--workers=1 --retries=0');
  });

  it('hard-deletes the direct RPC fixture through the guarded reserved-account door', () => {
    const script = read('scripts/ci/certify-club-create.mjs');
    const account = read('scripts/ci/production-e2e-account.mjs');
    const migration = read(
      'supabase/migrations/20260927001500_legacy_create_club_certificates_use_the_guarded_cleanup_door.sql'
    );
    expect(script).toContain('`ca-customization-cert-postdeploy-direct-${stamp}@example.invalid`');
    expect(script).toContain('cleanupProductionE2EAccount({');
    expect(script).toContain('record: { id: userId, email }');
    expect(script).not.toContain('Fixture User Delete Skipped');
    expect(script).toContain('await cleanupLegacyDirectCertificates()');
    expect(script).toContain('It Still Owns A Club.');
    expect(account).toContain("const LEGACY_DIRECT_PREFIX = 'club-create-cert-'");
    expect(migration).toContain("md5(v_old) <> '5097fd85191359890d70eb84c4ce507c'");
    expect(migration).toContain("LIKE 'club-create-cert-%@smarter-poker.invalid'");
  });

  it('archives the exact ledger actor before a reserved certification identity is removed', () => {
    const migration = read(
      'supabase/migrations/20260927032422_certification_accounts_archive_ledger_actor_before_deletion.sql'
    );

    expect(migration).toContain("md5(v_old) <> 'a600217942966c122d7f245d64df96aa'");
    expect(migration).toContain('CREATE TABLE public.ca_test_account_ledger_actor_archive');
    expect(migration).toContain('to_jsonb(l)');
    expect(migration).toContain('ALTER COLUMN performed_by DROP NOT NULL');
    expect(migration).toContain('LOCK TABLE public.chip_ledger IN ACCESS EXCLUSIVE MODE');
    expect(migration.indexOf('LOCK TABLE public.chip_ledger')).toBeLessThan(
      migration.indexOf('CREATE TABLE public.ca_test_account_ledger_actor_archive')
    );
    expect(migration).toContain("<> 'ce4ab3013be283d66ab9afd1e861b552'");
    expect(migration).toContain('CHIP_LEDGER_ACTOR_TRIGGER_PREIMAGE_CHANGED');
    expect(migration).toContain('CREATE TRIGGER trg_chip_ledger_performed_by_update');
    expect(migration).toContain('BEFORE UPDATE OF performed_by');
    expect(migration).not.toContain('DROP TRIGGER trg_chip_ledger_performed_by');
    expect(migration).toContain('INSERT INTO public.ca_declared_money_triggers');
    expect(migration).toContain("v_reason LIKE 'certification-cleanup:%'");
    expect(migration).toContain('NEW.performed_by IS NULL');
    expect(migration).toContain('a.ledger_row = to_jsonb(OLD)');
    expect(
      migration.indexOf('INSERT INTO public.ca_test_account_ledger_actor_archive')
    ).toBeLessThan(migration.indexOf('UPDATE public.chip_ledger'));
    expect(migration.indexOf('UPDATE public.chip_ledger')).toBeLessThan(
      migration.lastIndexOf('-- Preserve immutable ledger actors.')
    );
    expect(migration).toContain('v_ledger_archived_count <> v_ledger_count');
    expect(migration).toContain('Reserved Certification Ledger Actor Archive Copied');
    expect(migration).toContain("'^club-opening-grant:' || l.club_id::text || '(:[0-9]+)?$'");
    expect(migration).toContain("l.from_type IN ('issuance_reserve', 'system_mint')");
    expect(migration).toContain("l.from_type = 'settlement_suspense'");
    expect(migration).toContain("l.from_type = 'table_stack'");
    expect(migration).toContain('l.amount = 100000');
    expect(migration).toContain('l.to_entity_id = p_user_id');
    expect(migration).toContain('OR NOT (');
    expect(migration).toContain('Test-account ledger actor testimony is append-only');
    expect(migration).toContain('REVOKE ALL ON TABLE public.ca_test_account_ledger_actor_archive');
    expect(migration).not.toMatch(
      /CREATE TABLE public\.ca_test_account_ledger_actor_archive[\s\S]*?REFERENCES/
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.enforce_chip_ledger_performed_by() TO service_role'
    );
    expect(migration).not.toContain('DELETE FROM public.chip_ledger');
    expect(migration).not.toContain("SET performed_by = '00000000-0000-0000-0000-000000000001'");
  });

  it('sets the guarded maintenance reason before detaching an archived actor', () => {
    const migration = read(
      'supabase/migrations/20260927034804_certification_actor_detachment_sets_its_guard_marker.sql'
    );

    expect(migration).toContain("md5(v_old) <> '3f4d071ce514645f1881c31856a92e72'");
    expect(migration).toContain("'certification-cleanup:20260927034716:' || p_user_id::text");
    expect(migration.indexOf("PERFORM set_config(\n+    'app.ledger_maintenance'")).toBeLessThan(
      migration.indexOf('UPDATE public.chip_ledger')
    );
    expect(migration).not.toContain('DELETE FROM public.chip_ledger');
  });

  it('targets the unique keyboard-enabled action-bar control', () => {
    const spec = read('tests/e2e/production-create-club.spec.ts');
    expect(spec).toContain("getByTitle('Create A Club (C)', { exact: true })");
    expect(spec).toContain('test.describe.configure({ retries: 0 })');
    expect(spec).not.toContain("getByRole('button', { name: 'Create A Club', exact: true })");
  });

  it('proves the visible opening-bank command instead of a hidden live-region match', () => {
    const spec = read('tests/e2e/production-create-club.spec.ts');
    expect(spec).toContain('getByLabel(/^100,000(?:\\.00)? Club Bank Chips$/)');
    expect(spec).not.toContain('getByText(/100,000(?:\\.00)?/).first()');
  });

  it('bakes replayed cards from the authoritative server club and reports a failed URL write', () => {
    const service = read('src/services/ClubsService.ts');
    expect(service).toMatch(
      /clubName:\s*String\(data\.name \|\| safeName\)\s*\.trim\(\)\s*\.toUpperCase\(\)/
    );
    expect(service).toContain(
      "reportError(cardUpdateError, 'ClubsService.createClub.CardUrlUpdate')"
    );
    expect(service).toMatch(
      /if \(cardUpdateError\)[\s\S]*else \{\s*data\.card_image_url = urlData\.publicUrl;/
    );
  });
});
