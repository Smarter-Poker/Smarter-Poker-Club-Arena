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
  });

  it('targets the unique keyboard-enabled action-bar control', () => {
    const spec = read('tests/e2e/production-create-club.spec.ts');
    expect(spec).toContain("getByTitle('Create A Club (C)', { exact: true })");
    expect(spec).not.toContain("getByRole('button', { name: 'Create A Club', exact: true })");
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
