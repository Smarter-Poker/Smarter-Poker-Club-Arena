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
    expect(cleanup).toContain("'Crest Cert '");
    expect(cleanup).toContain("'Preset Crest Cert '");
    expect(cleanup).toContain('CERTIFICATION_CLUB_NAME_PREFIXES.some');
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
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('Resolve The Exact Revision Published By This Run');
    expect(workflow).toContain('actions/runs/$SOURCE_RUN_ID/artifacts?per_page=100');
    expect(workflow).toContain(
      'publisher-artifact "$SOURCE_RUN_ID" "$SOURCE_TRIGGER_SHA" "$REPOSITORY_ID"'
    );
    expect(workflow).toContain('steps.published.outputs.sha');
    expect(workflow).not.toContain(
      "ref: ${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha"
    );
    expect(workflow).toContain('expected="$(git rev-parse HEAD)"');
    expect(workflow).toContain('https://ca-static.smarter.poker/build-info.json');
    expect(workflow).toContain('https://smarter.poker/hub/club-arena/build-info.json');
    expect(workflow).toContain('production-e2e-provenance.mjs build-info');
    expect(workflow).toContain('"$origin_sha" == "$expected"');
    expect(workflow).toContain('"$public_sha" == "$expected"');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 60');
    expect(workflow).toContain('--workers=1 --retries=0');
  });

  it('supplies the direct database credential to every step that can retire a fixture club', () => {
    const workflow = read('.github/workflows/club-create-certification.yml');
    const step = (name: string) => {
      const start = workflow.indexOf(`      - name: ${name}`);
      expect(start, `workflow step ${name} must exist`).toBeGreaterThan(-1);
      const next = workflow.indexOf('\n      - name:', start + 1);
      return workflow.slice(start, next === -1 ? workflow.length : next);
    };

    for (const name of [
      'Certify Authenticated Club Creation And Cleanup',
      'Provision A Brand-New Player',
      'Retire The Created Club',
    ]) {
      expect(step(name)).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    }
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
    expect(script).toContain('await cleanupResidualDirectCertificates()');
    expect(script).toContain('retireCertificationClubWithRetry({');
    expect(script).toContain('environment: process.env');
    expect(script).toContain('cert-residue-recovery');
    expect(script).toContain('Still Owns A Club After Recovery.');
    expect(script).toContain(
      "Retired ${retired?.chips_retired ?? 'Unknown'} Chips Instead Of 100000"
    );
    expect(script).not.toContain("admin.rpc('fn_ca_retire_welcome_certification_club'");
    expect(account).toContain("SET LOCAL statement_timeout = '120s'");
    expect(account).toContain("SET LOCAL request.jwt.claim.role = 'service_role'");
    expect(account).toContain("SET LOCAL app.club_retirement_maintenance = 'on'");
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
    const markerAt = migration.indexOf("PERFORM set_config(\n    'app.ledger_maintenance'");
    expect(markerAt).toBeGreaterThan(-1);
    const detachAt = migration.indexOf('UPDATE public.chip_ledger', markerAt);
    expect(detachAt).toBeGreaterThan(markerAt);
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
    expect(spec).toContain('const responseBody = (await response.json()) as unknown');
    expect(spec).toContain('createdClub?.slug');
    expect(spec).toContain('createdClub?.id');
    expect(spec).toContain('escapeRegExp(createdClubRef)');
    expect(spec).not.toContain('/\\/clubs\\/[0-9a-f-]{36}');
    expect(spec).toContain('getByLabel(/^99\\.7K Club Bank Chips$/)');
    expect(spec).not.toContain('getByText(/99\\.7K/).first()');
  });

  it('dismisses the Diamond Spins interruption before opening setup', () => {
    const spec = read('tests/e2e/production-create-club.spec.ts');
    const diamondSpins = spec.indexOf(
      "const diamondSpins = page.getByRole('dialog', { name: /Diamond Spins/i })"
    );
    const visible = spec.indexOf('if (await diamondSpins.isVisible())', diamondSpins);
    const dismiss = spec.indexOf(
      "diamondSpins.getByRole('button', { name: 'Not Now', exact: true }).click()",
      visible
    );
    const hidden = spec.indexOf('await expect(diamondSpins).toBeHidden()', dismiss);
    const start = spec.indexOf(
      "getByRole('button', { name: 'Start Setup', exact: true }).click()",
      hidden
    );
    const wizard = spec.indexOf("const wizard = page.getByRole('dialog'", start);
    const assertion = spec.indexOf('await expect(wizard).toBeVisible()', start);

    expect(diamondSpins).toBeGreaterThan(-1);
    expect(visible).toBeGreaterThan(diamondSpins);
    expect(dismiss).toBeGreaterThan(visible);
    expect(hidden).toBeGreaterThan(dismiss);
    expect(start).toBeGreaterThan(hidden);
    expect(wizard).toBeGreaterThan(start);
    expect(assertion).toBeGreaterThan(wizard);
  });

  it('retires the created club through the published owner controls before cleanup', () => {
    const workflow = read('.github/workflows/club-create-certification.yml');
    const spec = read('tests/e2e/production-create-club.spec.ts');

    expect(spec).toContain('`./clubs/${createdClubRef}/settings`');
    expect(spec).toContain("getByRole('dialog', { name: 'Retire Club', exact: true })");
    expect(spec).toContain("getByLabel('Type The Club Name To Confirm:', { exact: true })");
    expect(spec).toContain('expect(confirmRetirement).toBeEnabled');
    // The UI stops at the enabled confirmation: a committed owner retirement
    // writes immutable cancellation receipts, so the fixture could never be
    // erased. The commit path is proved by the rollback probe instead.
    expect(spec).not.toContain('fn_retire_settled_club');
    expect(spec).not.toContain('confirmRetirement.click()');
    expect(workflow).toContain('test-results/create-club-retire-ready-mobile.png');
    expect(workflow.indexOf('Create A Club Through The Published User Interface')).toBeLessThan(
      workflow.indexOf('Retire The Created Club')
    );
  });

  it('certifies the first-club package, lifetime-second refusal and visible package rows', () => {
    const script = read('scripts/ci/certify-club-create.mjs');
    const spec = read('tests/e2e/production-create-club.spec.ts');

    expect(script).toContain("'fn_get_club_welcome_package'");
    expect(script).toContain('const retryRead = (label, operation) =>');
    expect(script).toContain('welcome package read for certification club');
    expect(script).toContain('welcome package refusal read for certification club');
    expect(script.match(/retryRead\(/g)?.length).toBeGreaterThanOrEqual(15);
    expect(script).toContain('certifyWelcomeResetInsideRollback({');
    expect(script).toContain(
      'SELECT public.fn_remove_first_club_welcome_games($1::uuid,$2::uuid) AS result'
    );
    expect(script).toContain('SET LOCAL ROLE authenticated');
    expect(script).toContain("set_config('request.jwt.claims',$1::text,true)");
    expect(script).toContain("set_config('request.jwt.claim.sub',$2::text,true)");
    expect(script).toContain('SELECT public.fn_ca_lock_settlement_lane_global()');
    expect(script).not.toContain('SELECT pg_advisory_xact_lock(530090,1)');
    expect(script).toContain('SELECT 1 FROM public.clubs WHERE id=$1::uuid FOR UPDATE');
    expect(script).toContain('ORDER BY slot_key FOR UPDATE');
    expect(script).toContain('SELECT 1 FROM public.tournament_schedules');
    expect(script).toContain('SELECT 1 FROM public.tournament_schedule_spawns');
    expect(script).toContain(') ORDER BY id FOR UPDATE');
    expect(script).toContain('SELECT 1 FROM public.tournaments t');
    expect(script).toContain(') ORDER BY t.id FOR UPDATE');
    expect(script).toContain("await client.query('ROLLBACK')");
    expect(script).not.toContain("await client.query('COMMIT')");
    expect(script).toContain(
      'label: `rollback-only welcome reset certification for club ${club.id}`'
    );
    expect(script).toContain('welcomeCash.length !== 9');
    expect(script).toContain('welcomeSchedules.length !== 1');
    expect(script).toContain("welcome?.status !== 'provisioned'");
    expect(script).toContain('Number(welcomeEconomics.bbj_seed) !== 100');
    expect(script).toContain('Number(welcomeEconomics.spin_seed) !== 200');
    expect(script).toContain("secondWelcome?.status !== 'not_eligible'");
    expect(script).toContain(".from('club_welcome_package_funding')");
    expect(spec).toContain("name: 'Opening Welcome Package'");
    expect(spec).toContain("getByText('9 Preloaded', { exact: true })");
    expect(spec).toContain("getByText('Owner Acceptance Required', { exact: true })");
    expect(spec).toContain("getByText('Daily $25 Freezeout · 7 PM UTC', { exact: true })");
  });

  it('fails closed around independent reset preimages and exact residue cleanup', () => {
    const script = read('scripts/ci/certify-club-create.mjs');

    const globalLane = script.indexOf('SELECT public.fn_ca_lock_settlement_lane_global()');
    const serviceRole = script.indexOf('SET LOCAL ROLE service_role', globalLane);
    const clubLock = script.indexOf('SELECT 1 FROM public.clubs WHERE id=$1::uuid FOR UPDATE');
    const packageItemLocks = script.indexOf('ORDER BY slot_key FOR UPDATE');
    const scheduleLocks = script.indexOf(
      'SELECT 1 FROM public.tournament_schedules',
      packageItemLocks
    );
    const scheduleLockOrder = script.indexOf(') ORDER BY id FOR UPDATE', scheduleLocks);
    const spawnLocks = script.indexOf(
      'SELECT 1 FROM public.tournament_schedule_spawns',
      scheduleLockOrder
    );
    const spawnLockOrder = script.indexOf(') ORDER BY id FOR UPDATE', spawnLocks);
    const tournamentLocks = script.indexOf('SELECT 1 FROM public.tournaments t', spawnLockOrder);
    const tournamentLockOrder = script.indexOf(') ORDER BY t.id FOR UPDATE', tournamentLocks);
    const preimage = script.indexOf('AS cash_game_ids');
    const authenticatedRole = script.indexOf('SET LOCAL ROLE authenticated');
    const mutation = script.indexOf('public.fn_remove_first_club_welcome_games');
    const rollback = script.indexOf("await client.query('ROLLBACK')");

    expect(globalLane).toBeGreaterThan(-1);
    expect(globalLane).toBeLessThan(serviceRole);
    expect(serviceRole).toBeLessThan(clubLock);
    expect(script).not.toContain('SELECT pg_advisory_xact_lock(530090,1)');
    expect(clubLock).toBeLessThan(packageItemLocks);
    expect(packageItemLocks).toBeLessThan(scheduleLocks);
    expect(scheduleLocks).toBeLessThan(scheduleLockOrder);
    expect(scheduleLockOrder).toBeLessThan(spawnLocks);
    expect(spawnLocks).toBeLessThan(spawnLockOrder);
    expect(spawnLockOrder).toBeLessThan(tournamentLocks);
    expect(tournamentLocks).toBeLessThan(tournamentLockOrder);
    expect(tournamentLockOrder).toBeLessThan(preimage);
    expect(preimage).toBeLessThan(authenticatedRole);
    expect(authenticatedRole).toBeLessThan(mutation);
    expect(mutation).toBeLessThan(rollback);
    // Deferred constraint triggers (tournaments_cancel_must_refund) are fired
    // inside the probe, so a reset that could not COMMIT fails here instead.
    const deferredChecks = script.indexOf("await client.query('SET CONSTRAINTS ALL IMMEDIATE')");
    expect(mutation).toBeLessThan(deferredChecks);
    expect(deferredChecks).toBeLessThan(rollback);

    const retry = script.indexOf('await retryTransient(', script.indexOf('const resetOperationId'));
    const rollbackOnlyReset = script.indexOf('certifyWelcomeResetInsideRollback({', retry);
    expect(retry).toBeGreaterThan(-1);
    expect(retry).toBeLessThan(rollbackOnlyReset);
    expect(script).not.toContain("await client.query('COMMIT')");

    expect(script).toContain(
      'Welcome Reset Preimage Did Not Match The Independently Observed Package Graph.'
    );
    expect(script).toContain(
      'Welcome Reset Receipt Did Not Name The Complete Independent Package Graph.'
    );
    expect(script).toContain(".select('id,name,is_union,union_id')");
    expect(script).toContain('Certification Owner Has Unexpected Club State:');
    expect(script).toContain('data?.already_gone || Number(data?.chips_retired) !== 100000');
    expect(script).toContain('Fixture Cleanup Failed For ${clubId}: ${error.message}');
    expect(script).toContain('Still Owns Club Logo Assets.');
    expect(script).toContain('Still Exists After Cleanup.');
  });

  it('compares the reset receipt against both snapshots instead of demanding a still platform', () => {
    const script = read('scripts/ci/certify-club-create.mjs');

    // The preimage and the reset are separate statements in a READ COMMITTED
    // transaction, so a welcome schedule's background spawn can commit between
    // them. Set equality asserted that nothing committed during the probe and
    // went red at random; the receipt must instead name EVERY observed entity
    // and nothing outside the club.
    expect(script).toContain('const namesEveryId = (receipt, observed) =>');
    expect(script).toContain('!namesEveryId(removed?.cash_game_ids, expected?.cash_game_ids)');
    expect(script).toContain('!namesEveryId(removed?.table_ids, expected?.table_ids)');
    expect(script).toContain('!namesEveryId(removed?.schedule_ids, expected?.schedule_ids)');
    expect(script).toContain('!namesEveryId(removed?.tournament_ids, expected?.tournament_ids)');
    expect(script).not.toMatch(/sameIds\(\s*resetResult\?\.removed/);
    expect(script).toContain(
      'Welcome Reset Receipt Named An Entity Outside The Certification Club.'
    );
    expect(script).toContain('!namesEveryId(readback?.club_cash_game_ids, removed?.cash_game_ids)');
    expect(script).toContain('!namesEveryId(readback?.club_table_ids, removed?.table_ids)');

    // Every entity the receipt names is read back in the zero state, which is
    // what keeps the subset comparison from going slack.
    expect(script).toContain('removed?.cash_game_ids ?? []');
    expect(script).toContain('removed?.table_ids ?? []');
    expect(script).toContain('resetCashRead?.length !== resetRemoved?.cash_game_ids?.length');
    expect(script).toContain('resetTableRead?.length !== resetRemoved?.table_ids?.length');
    expect(script).toContain('resetScheduleRead?.length !== resetRemoved?.schedule_ids?.length');
    expect(script).toContain(
      'resetTournamentRead?.length !== resetRemoved?.tournament_ids?.length'
    );

    // managed_game_schedules is keyed on schedule_id. Selecting "id" raised
    // 42703 and killed the whole certification at the readback.
    expect(script).toContain('SELECT schedule_id,status FROM public.managed_game_schedules');
    expect(script).not.toMatch(/SELECT id,status FROM public\.managed_game_schedules/);
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
