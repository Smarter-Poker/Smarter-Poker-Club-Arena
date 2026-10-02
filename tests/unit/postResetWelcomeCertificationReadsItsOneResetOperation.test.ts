import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Postgres has no min(uuid). The post-reset welcome-certification preparer
 * shipped on 2026-10-02 reading its single reset operation with min() over a
 * uuid column, so plpgsql raised 42883 on its first and every call and the
 * whole branch never once completed: Club Create Certification run 37073302753
 * died in residue cleanup, not in club creation.
 *
 * The cast is the fix. These pins exist so the bare aggregate cannot come back
 * in the function body, and so the one place it is still written down - the
 * header that explains the defect - cannot be mistaken for the code.
 */
const MIGRATION = '20261002225231_post_reset_welcome_certification_reads_its_one_reset_operati.sql';
const source = readFileSync(resolve(__dirname, '../../supabase/migrations', MIGRATION), 'utf8');
const body = source.slice(source.indexOf('\nBEGIN;'));

describe('the post-reset welcome certification preparer reads its one reset operation', () => {
  it('takes the uuid extremum the way this database already takes one', () => {
    expect(body).toContain('SELECT min(reset_operation_id::text)::uuid,');
  });

  it('leaves no bare min() over a uuid column anywhere in the shipped SQL', () => {
    expect(body).not.toMatch(/\bmin\s*\(\s*reset_operation_id\s*\)/i);
    expect(body).not.toMatch(/\bmin\s*\(\s*[A-Za-z_.]*(?:_id|_uuid)\s*\)/i);
  });

  it('replaces the preparer and nothing else, in one transaction, with its proof', () => {
    expect(body).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture('
    );
    expect(body).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'
    );
    expect(body).toContain('FROM PUBLIC,anon,authenticated,service_role');
    expect(body).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_prepare_post_reset_welcome_certification_fixture/
    );
    expect(body.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(body.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(source).toMatch(/^-- @live-proof:/m);
    expect(source.trim()).toMatch(/COMMIT;$/);
  });

  it('keeps the admission chain that 20261002210559 established', () => {
    for (const pin of [
      'WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED',
      'POST_RESET_CERTIFICATION_PACKAGE_LINEAGE_REFUSED',
      'POST_RESET_CERTIFICATION_RECEIPT_REFUSED',
      'POST_RESET_CERTIFICATION_ACTIVITY_REFUSED',
      'POST_RESET_CERTIFICATION_TABLE_DELETE_PERMIT_NOT_CONSUMED',
      "'financial_history_preserved',true",
    ]) {
      expect(body).toContain(pin);
    }
    // The lineage check is what makes any one of the equal operation ids the
    // right answer. Without it the cast would be papering over an ambiguity.
    expect(body).toContain('i.reset_operation_id IS DISTINCT FROM v_operation');
  });
});
