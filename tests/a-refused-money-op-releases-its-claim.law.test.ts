/**
 * ===========================================================================
 *  LAW: A MONEY DOOR THAT REFUSES AFTER TAKING ITS CLAIM GIVES THE CLAIM BACK
 * ===========================================================================
 *
 * fn_ca_mint and fn_ca_burn take the idempotency claim before they do the
 * work, and every refusal between the claim and the finalize says no with a
 * plain plpgsql RETURN. A RETURN rolls nothing back, so the claim row commits
 * with result NULL and finalized_at NULL and stays there for good: the
 * operation never happened, and the row says somebody is still doing it.
 *
 * MEASURED IN PRODUCTION 2026-09-19, before the migration this pins:
 *
 *   289 rows in public.ca_op_claims with finalized_at NULL, all fn_ca_mint,
 *   all claimed between 2026-09-08 06:20:44 and 2026-09-09 06:09:53 and none
 *   after - 260 under 'signup:<uid>', 29 under
 *   'daily-missions-historical-fixture:'. Of all 289: 0 had a ca_mint_ledger
 *   row, 0 had a chip_ledger leg under 'mint:<op id>', 0 had a
 *   diamond_transactions row under reference_id. No money moved for any of
 *   them. A crash cannot leave one of these rows - a dead backend takes the
 *   claim INSERT down with the rest of its transaction - so a committed claim
 *   with no result is always a refusal that returned.
 *
 *   The refusal was the ceiling: in the 24 hours ending at one of those
 *   claims, diamond issuance was 2,784,110 over 36,816 rows against
 *   ca_mint_policy.rolling_24h_cap_diamonds of 2,000,000.
 *
 * WHY THIS IS A LAW RATHER THAN A TIDY-UP. Nothing was stuck: both doors
 * delete an unfinalized claim for the same op id and take it again, so
 * idempotency held throughout. What the residue did was hold an alarm red for
 * ever. scripts/ci/check-chip-conservation.mjs fails while ANY claim has been
 * open longer than an hour, and it is the only thing watching for a money
 * operation that stopped half way. Under 289 permanent rows it could never go
 * green, so it could never go red AT anyone. That is the regression worth
 * guarding: not the rows, the blinded alarm.
 *
 * Three things are pinned, all against migration text, and every one is
 * negative-controlled against the last full body of both doors
 * (20260904194036_the_mint_hardened.sql). If a pin passes against THAT, it is
 * not measuring the rule.
 *
 *   1. Every refusal sitting after the claim - four in fn_ca_mint, seven in
 *      fn_ca_burn - returns through public.fn_ca_release_claim, and each is
 *      patched against the live body with an expected match count of exactly
 *      one, so a sibling agent's concurrent edit elsewhere in either body
 *      cannot be overwritten by a stale full-body replacement.
 *   2. fn_ca_release_claim releases ONLY an unfinalized claim and hands the
 *      refusal back unchanged. A finalized row carries the result every later
 *      call replays; deleting one would turn a replay back into a second live
 *      operation.
 *   3. The rows removed are only rows that carry no money anywhere - no
 *      register row, no journal leg under either door's key, no diamond
 *      journal row under the op id. A claim with money behind it is left
 *      exactly where it is and the audit keeps failing at it, which is what a
 *      genuinely half-finished operation should look like.
 *
 * And one forward guard, which is the failure this law actually expects: a
 * later migration that replaces either door from an older mirror would carry
 * the bare refusals back in, silently, with the audit still green because the
 * rows take days to appear. No migration newer than this one may define either
 * door with a refusal after the claim that does not release it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceDollarQuoted } from './helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

const RELEASE_MIGRATION =
  'supabase/migrations/20260919064146_a_refused_money_op_releases_its_claim.sql';
/** The last full body of both doors before this law: the negative control. */
const PREVIOUS_BODIES = 'supabase/migrations/20260904194036_the_mint_hardened.sql';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read(RELEASE_MIGRATION);
const OLD_SQL = read(PREVIOUS_BODIES);

/** The version this law lands on. Anything newer is bound by the forward guard. */
const THIS_VERSION = '20260919064146';

/**
 * The refusals that sit AFTER the claim in each door, in source order. Anything
 * earlier refuses before the claim exists and has nothing to give back.
 */
const AFTER_THE_CLAIM: Array<[string, string]> = [
  ['fn_ca_mint', 'over_the_rolling_24h_issuance_ceiling'],
  ['fn_ca_mint', 'player_not_found'],
  ['fn_ca_mint', 'club_not_found'],
  ['fn_ca_mint', 'union_not_found'],
  ['fn_ca_burn', 'that_would_take_the_house_below_zero'],
  ['fn_ca_burn', 'player_not_found'],
  ['fn_ca_burn', 'that_would_take_the_balance_below_zero'],
  ['fn_ca_burn', 'club_not_found'],
  ['fn_ca_burn', 'that_would_take_the_treasury_below_zero'],
  ['fn_ca_burn', 'union_wallet_not_found'],
  ['fn_ca_burn', 'that_would_take_the_union_bank_below_zero'],
];

const BARE_REFUSAL = "RETURN jsonb_build_object('ok', false";

interface Patch {
  fn: string;
  from: string;
  to: string;
  /** Everything after the closing $ca_to$: carries the expected match count. */
  tail: string;
}

/**
 * Every `SELECT pg_temp.ca_patch('<fn>', $ca_from$..$ca_from$, $ca_to$..$ca_to$, n);`
 * in the migration, split on the call itself rather than on a byte window, so a
 * patch added later is seen and one that grows is not cut in half.
 */
function patches(sql: string): Patch[] {
  return sql
    .split('SELECT pg_temp.ca_patch(')
    .slice(1)
    .map((chunk) => {
      const fn = chunk.slice(1, chunk.indexOf("'", 1));
      const from = sliceDollarQuoted(chunk, '$ca_from$');
      const to = sliceDollarQuoted(chunk, '$ca_to$');
      const closeTo = chunk.indexOf('$ca_to$', chunk.indexOf('$ca_to$') + '$ca_to$'.length);
      return { fn, from, to, tail: chunk.slice(closeTo + '$ca_to$'.length) };
    });
}

/** One function's body from `AS $tag$` to its closing tag, or null if absent. */
function functionBody(sql: string, name: string): string | null {
  const at = sql.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\s*\\(`));
  if (at < 0) return null;
  const rest = sql.slice(at);
  const open = rest.match(/\bAS\s+(\$[A-Za-z_]*\$)/);
  if (!open || open.index === undefined) return null;
  const tag = open[1];
  const bodyStart = open.index + open[0].length;
  const close = rest.indexOf(tag, bodyStart);
  return close < 0 ? rest.slice(bodyStart) : rest.slice(bodyStart, close);
}

/** The part of a body that runs once the claim has been taken. */
function afterTheClaim(body: string): string | null {
  const claim = body.indexOf('INSERT INTO public.ca_op_claims');
  return claim < 0 ? null : body.slice(claim);
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('a refused money op releases its claim', () => {
  const PATCHES = patches(SQL);

  it('patches exactly the refusals that sit after the claim, and no others', () => {
    expect(PATCHES).toHaveLength(AFTER_THE_CLAIM.length);
    const seen = PATCHES.map((p) => {
      const reason = p.from.match(/'reason', '([a-z0-9_]+)'/);
      expect(reason, `every patched marker names a refusal reason: ${p.from}`).not.toBeNull();
      return [p.fn, reason![1]];
    });
    expect(seen).toEqual(AFTER_THE_CLAIM);
  });

  it.each(AFTER_THE_CLAIM)('%s refusing with %s returns through the release', (fn, reason) => {
    const patch = PATCHES.find((p) => p.fn === fn && p.from.includes(`'${reason}'`));
    expect(patch, `${fn} has no patch for ${reason}`).toBeDefined();

    // The marker being replaced is the bare refusal, and only that.
    expect(patch!.from).toContain(BARE_REFUSAL);
    expect(patch!.from).not.toContain('fn_ca_release_claim');

    // What replaces it returns through the release, naming its own door, and
    // no longer returns a refusal on its own.
    expect(patch!.to).toContain(`RETURN public.fn_ca_release_claim('${fn}', p_op_id,`);
    expect(patch!.to).toContain(`'reason', '${reason}'`);
    expect(patch!.to).not.toContain(BARE_REFUSAL);

    // Exactly one occurrence, asserted at apply time: a marker that has moved
    // or been duplicated by a sibling agent stops the migration instead of
    // silently patching the wrong place - or none.
    expect(patch!.tail.replace(/\s+/g, ' ')).toContain(', 1);');
  });

  it('the negative control: those same refusals WERE bare in the last full bodies', () => {
    for (const door of ['fn_ca_mint', 'fn_ca_burn']) {
      const body = functionBody(OLD_SQL, door);
      expect(body, `${door} is defined in ${PREVIOUS_BODIES}`).not.toBeNull();
      const tail = afterTheClaim(body!);
      expect(tail, `${door} took a claim in ${PREVIOUS_BODIES}`).not.toBeNull();

      const expectedBare = AFTER_THE_CLAIM.filter(([fn]) => fn === door).length;
      expect(
        countOf(tail!, BARE_REFUSAL),
        `${door} in ${PREVIOUS_BODIES} must still show the ${expectedBare} unreleased ` +
          `refusals this law removes - if it does not, the pins above are measuring nothing`
      ).toBe(expectedBare);
      expect(tail!).not.toContain('fn_ca_release_claim');
    }
  });

  it('the release touches an unfinalized claim only, and changes the refusal not at all', () => {
    const body = functionBody(SQL, 'fn_ca_release_claim');
    expect(body, 'the migration defines fn_ca_release_claim').not.toBeNull();
    expect(body!).toContain('DELETE FROM public.ca_op_claims');
    // A finalized row carries the result every later call replays.
    expect(body!).toMatch(/WHERE op_id = p_op_id AND fn_name = p_fn AND finalized_at IS NULL/);
    expect(body!).toContain('RETURN p_refusal;');
    // It hands back what it was given - it does not compose a refusal of its own.
    expect(body!).not.toContain('jsonb_build_object');
    // And nobody can call it from outside the two doors.
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_release_claim(text, text, jsonb) FROM PUBLIC, anon, authenticated;'
    );
  });

  it('removes only claims that carry no money anywhere', () => {
    const block = sliceDollarQuoted(SQL, '$release_the_residue$');
    expect(block).toContain('DELETE FROM public.ca_op_claims c');
    expect(block).toContain('c.finalized_at IS NULL');
    expect(block).toContain('c.result IS NULL');
    // The register, the chip journal under either door's key, and the diamond
    // journal under the op id. All three, or a half-finished operation is
    // removed along with the residue and nobody ever learns of it.
    expect(block).toContain(
      'NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.op_id = c.op_id)'
    );
    expect(block).toContain("l.idempotency_key IN ('mint:' || c.op_id, 'burn:' || c.op_id)");
    expect(block).toContain(
      'NOT EXISTS (SELECT 1 FROM public.diamond_transactions d WHERE d.reference_id = c.op_id)'
    );
  });

  it('proves itself against the live catalog before it commits', () => {
    const block = sliceDollarQuoted(SQL, '$prove_it$');
    // Both doors, read from pg_proc rather than from this file.
    expect(block).toContain("ARRAY['fn_ca_mint', 'fn_ca_burn']");
    expect(block).toContain('pg_get_functiondef(p.oid)');
    expect(block).toContain("position('INSERT INTO public.ca_op_claims' in v_def)");
    // An unreleased refusal after the claim stops the migration.
    expect(block).toMatch(/IF v_bare <> 0 THEN\s*\n\s*RAISE EXCEPTION/);
    // A claim left behind carries money evidence: it must stay visible, and it
    // is not a reason to roll the door fix back.
    expect(block).toMatch(/RAISE WARNING 'ca_op_claims still holds/);
  });

  /**
   * THE ONE THAT MATTERS LATER. `CREATE OR REPLACE FUNCTION public.fn_ca_mint`
   * built from a mirror taken before today puts every bare refusal back, and
   * nothing goes red for days - the rows only accumulate when the ceiling is
   * next hit. Patch the live body by marker (as this migration does), or carry
   * the release through.
   */
  it('no migration after this one re-defines either door with an unreleased refusal', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(MIGRATIONS).sort()) {
      if (!file.endsWith('.sql')) continue;
      const version = file.slice(0, file.indexOf('_'));
      if (version <= THIS_VERSION) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
      for (const door of ['fn_ca_mint', 'fn_ca_burn']) {
        const body = functionBody(sql, door);
        if (!body) continue;
        const tail = afterTheClaim(body);
        if (!tail) continue;
        const bare = countOf(tail, BARE_REFUSAL);
        if (bare > 0) offenders.push(`${file}: ${door} has ${bare} unreleased refusal(s)`);
      }
    }
    expect(
      offenders,
      'a later migration re-defines a money door with a refusal that returns without ' +
        'releasing its claim. Patch the live body by marker the way ' +
        `${RELEASE_MIGRATION} does, or route the refusal through ` +
        'public.fn_ca_release_claim.'
    ).toEqual([]);
  });
});
