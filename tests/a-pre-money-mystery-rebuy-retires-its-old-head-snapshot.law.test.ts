/**
 * A PRE-MONEY MYSTERY REBUY RETIRES ITS OLD HEAD SNAPSHOT (2026-10-24)
 *
 * 20261024075911 let a pre-money mystery bust be rebought, but refused any
 * entry whose current_bounty was non-zero. Every mystery entry carries
 * current_bounty = bounty_amount from registration and keeps it through a
 * pre-money bust, so the first two mystery events after install refused every
 * rebuy (160 refusals in 20 minutes, zero rebuys). current_bounty is a snapshot
 * there; the money stays in tournaments.bounty_pool. This pins the paid path's
 * own exact retirement in the pre-money branch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20261024204950_a_pre_money_mystery_rebuy_retires_its_old_head_snapshot.sql'
  ),
  'utf8'
);
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');
const replacement = sql.slice(sql.indexOf('v_new := $new$'), sql.indexOf('EXECUTE replace('));

describe('a pre-money mystery rebuy retires its old head snapshot', () => {
  it('is one transaction patching the measured body by exact anchor', () => {
    expect(code.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(code.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(code).toContain("md5(v_src) <> 'b254f96b52b6ac9fb26a8a3e3994017b'");
    expect(code).toContain(
      "RAISE EXCEPTION 'pre-money mystery head anchor is not present exactly once'"
    );
    // The old refusal is the anchor, and must be gone afterwards.
    expect(code).toContain(
      "OR position('Pre-money mystery rebuy found a live bounty head' IN v_src) > 0 THEN"
    );
  });

  it('retires only 0 or exactly the event head, once, and refuses anything else', () => {
    expect(replacement).toContain('FOR UPDATE;');
    expect(replacement).toContain(
      'AND round(COALESCE(v_head_after,0),2)<>round(COALESCE(v_t.bounty_amount,0),2) THEN'
    );
    expect(replacement).toContain("'Bounty rebuy old head changed before retirement'");
    expect(replacement).toMatch(
      /SET current_bounty=0\s+WHERE tp\.tournament_id=p_tournament_id AND tp\.user_id=p_user_id\s+AND round\(COALESCE\(tp\.current_bounty,0\),2\) IN\s+\(0,round\(COALESCE\(v_t\.bounty_amount,0\),2\)\);/
    );
    expect(replacement).toContain("'Bounty rebuy old head was not retired exactly once'");
    expect(replacement).not.toContain('Pre-money mystery rebuy found a live bounty head');
  });

  it('still answers no_bounty_head for the pre-money claim only, and reports the head it retired', () => {
    expect(replacement).toContain(
      "'no_bounty_head',true,'old_head',round(COALESCE(v_head_after,0),2),"
    );
    // The anchor ends inside the mystery_pre RETURN, so the claim conditions
    // that guard this branch (pinned by the 075911 law) are untouched.
    expect(replacement).toContain("'ok',true,'obligation_id',NULL,'mode','mystery_pre',");
  });

  it('keeps the step private and security definer', () => {
    expect(code).toContain(
      "p.proconfig = ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]"
    );
    for (const role of ['service_role', 'authenticated', 'anon']) {
      expect(code).toContain(`AND NOT has_function_privilege('${role}', p.oid, 'EXECUTE')`);
    }
  });
});
