/**
 * A BREAK ITS DEAD GENERATION BEGAN IS FINISHED BY ITS SUCCESSOR (2026-09-26)
 *
 * Event 7c6277e7, table 244a2997, break dce8ddb0: begun by generation
 * 29afae24, one member moved, seven attempts active, the generation dead. The
 * successor's only door into the break's custody,
 * public.fn_f06_admit_parked_movement, refused it for a week with
 * F06_MOVEMENT_ORIGINAL_PROOF_MISSING: a break begun under a live dealer never
 * records a movement admission to carry forward, and the door would only take
 * a fresh proof for an untouched park.
 *
 * Two fixes were written the same morning. 20260926092954 (PR #5328) merged
 * and was never applied; 20260926091645 was applied to production at 09:3x
 * UTC and brought to main afterwards. The live one is 20260926091645: the
 * door takes a fresh proof for a BEGUN break with a manifest too, and the
 * proof (smarter_private.f06_movement_prior) accounts for every member from
 * durable receipts - a moved member by its winner receipt, the rest by their
 * live seats and registrations - and names the break it was taken for. The
 * break then finished through the protocol's own claim, moves, close and
 * acknowledgement; 7c6277e7 completed at 09:50:11 and paid 283.80 once.
 * 20260926092954 was deleted in the pull request that says so.
 *
 * These laws read the LATEST migration that defines the door, so a later
 * redefinition is held to the same rules, and each rule has a planted
 * regression the same check refuses.
 *
 * docs/changelog/2026-09-26-a-break-its-dead-generation-began-is-finished-by-its-successor.md
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const DOOR =
  /CREATE (?:OR REPLACE )?FUNCTION public\.fn_f06_admit_parked_movement\([\s\S]*?AS (\$[a-z_]*\$)([\s\S]*?)\1;/;

function latestDoor(): { file: string; body: string } {
  let found: { file: string; body: string } | null = null;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const m = readFileSync(join(MIGRATIONS, file), 'utf8').match(DOOR);
    if (m) found = { file, body: m[2] };
  }
  if (!found) throw new Error('no migration defines public.fn_f06_admit_parked_movement');
  return found;
}

const flat = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, '');

/** Every broken rule, empty when the door keeps them. */
function violations(body: string): string[] {
  const c = flat(body);
  const out: string[] = [];
  if (!c.includes("(o.state='begun'ANDo.manifestISNOTNULL)"))
    out.push('a begun break with a manifest cannot take a fresh proof');
  if (!c.includes("(o.state='park_requested'ANDo.manifestISNULL)"))
    out.push('an untouched park can no longer take a fresh proof');
  if (!c.includes('proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);'))
    out.push('the fresh proof is not taken from f06_movement_prior');
  if (
    !c.includes(
      "IFo.state='begun'ANDproof#>>'{receipts,break_id}'ISDISTINCTFROMp_break_id::textTHENRAISEEXCEPTION'F06_MOVEMENT_ORIGINAL_PROOF_MISSING'"
    )
  )
    out.push('a begun break accepts a proof that does not name it');
  if (!c.includes('proof:=prior.proof;'))
    out.push('a successor no longer carries a recorded proof');
  const claim = c.indexOf('claimed:=public.fn_f06_claim_custody(');
  const prove = c.indexOf('proof:=smarter_private.f06_movement_prior(');
  if (claim < 0 || prove < 0 || claim < prove)
    out.push('custody is claimed before the proof is taken');
  if ((c.match(/PERFORMsmarter_private\.f06_assert_movement\(p_break_id\);/g) ?? []).length < 2)
    out.push('an admission, fresh or replayed, is not held to f06_assert_movement');
  return out;
}

describe('a break its dead generation began is finished by its successor', () => {
  const { file, body } = latestDoor();

  it('the latest door keeps every rule', () => {
    expect(file >= '20260926091645', file).toBe(true);
    expect(violations(body)).toEqual([]);
  });

  it('the unapplied 20260926092954 is gone, and nothing promises what it would have installed', () => {
    expect(readdirSync(MIGRATIONS).some((f) => f.startsWith('20260926092954'))).toBe(false);
    const manifest = join(__dirname, '..', 'scripts', 'ci', 'schema-manifest.d');
    for (const f of readdirSync(manifest))
      expect(readFileSync(join(manifest, f), 'utf8')).not.toContain(
        'f06_movement_abandoned_begun_proof'
      );
  });

  describe('planted regressions are refused', () => {
    const plant = (from: string, to: string) => {
      expect(body.includes(from), from).toBe(true);
      return body.replace(from, to);
    };

    it('the door back to untouched parks only (the shape that stranded 7c6277e7)', () => {
      const bad = plant(" OR (o.state='begun' AND o.manifest IS NOT NULL)", '');
      expect(violations(bad)).toContain('a begun break with a manifest cannot take a fresh proof');
    });

    it('a begun break taking a proof that names no break', () => {
      const bad = plant(
        " IF o.state='begun' AND proof#>>'{receipts,break_id}' IS DISTINCT FROM p_break_id::text THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;\n",
        ''
      );
      expect(violations(bad)).toContain('a begun break accepts a proof that does not name it');
    });

    it('custody claimed before any proof', () => {
      const bad = plant(
        ' claimed:=public.fn_f06_claim_custody(',
        ' claimed:=public.fn_f06_claim_custody(p_tournament_id,p_lease_generation,p_break_id,p_custody_id,p_expected_revision);\n proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);\n claimed:=public.fn_f06_claim_custody('
      ).replace(
        /\n proof:=smarter_private\.f06_movement_prior\(p_tournament_id,p_table_id\);\n IF o\.state='begun'/,
        "\n IF o.state='begun'"
      );
      expect(violations(bad)).toContain('custody is claimed before the proof is taken');
    });

    it('a fresh admission not held to f06_assert_movement', () => {
      const i = body.lastIndexOf(' PERFORM smarter_private.f06_assert_movement(p_break_id);');
      const bad =
        body.slice(0, i) +
        body.slice(i + ' PERFORM smarter_private.f06_assert_movement(p_break_id);'.length);
      expect(violations(bad)).toContain(
        'an admission, fresh or replayed, is not held to f06_assert_movement'
      );
    });
  });
});
