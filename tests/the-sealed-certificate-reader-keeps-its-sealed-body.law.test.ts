/**
 * THE SEALED CERTIFICATE READER KEEPS ITS SEALED BODY (2026-10-16).
 *
 * Pinned on migration
 * 20261016133404_the_sealed_certificate_reader_keeps_its_sealed_body.sql.
 *
 * fn_accounting_close_certificate is one of the 40 proof sources sealed by md5
 * in smarter_private.original_inventory_proof_sources_match(). 20261016123337
 * rewrote it, the seal broke, original_inventory_basis_generation() went NULL
 * and every weekly close fell back to re-proving its week live. It is back on
 * its sealed body. Any change to a sealed proof source must re-seal it in the
 * same migration, deliberately; a 'harmless' rewrite is not harmless here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'supabase/migrations');
const sql = readFileSync(
  join(DIR, '20261016133404_the_sealed_certificate_reader_keeps_its_sealed_body.sql'),
  'utf8'
);
const SEAL = '7b4a5f4572a45db069b6058899614021';

describe('the sealed certificate reader keeps its sealed body', () => {
  it('restores the exact sealed body and proves the seal holds', () => {
    expect(sql.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(new RegExp(SEAL, 'g'))?.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain('smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true');
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(2);
  });

  it('no later migration rewrites fn_accounting_close_certificate without re-sealing it', () => {
    const later = readdirSync(DIR).filter((f) => f.endsWith('.sql') && f > '20261016133404');
    for (const f of later) {
      const s = readFileSync(join(DIR, f), 'utf8');
      if (/FUNCTION\s+public\.fn_accounting_close_certificate\s*\(/.test(s) || s.includes("'public.fn_accounting_close_certificate(")) {
        expect(s, `${f} touches the sealed certificate reader`).toContain('original_inventory_proof_sources_match');
      }
    }
  });
});
