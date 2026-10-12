/**
 * A LATE TICKET ENTRY WAKES ITS MANAGER WITH A REASON THE DOOR KNOWS (2026-10-12).
 *
 * The ticket door woke the tournament manager with 'late_ticket_registration',
 * a reason fn_emit_tournament_manager_wake refuses ('invalid tournament
 * manager wake reason') and the tournament_manager_wakes reason check would
 * refuse too. The raise rolled back the whole late admission. It was hidden
 * behind the count refusal that 20261012031813 removed, and then refused 10 of
 * 10 late ticket entries on 2026-10-12 05:08 to 05:28 UTC.
 *
 * This pins 20261012112543 (the door now emits 'late_registration', the reason
 * the engine acts on) and refuses any later migration that hands the wake door
 * a literal reason outside its closed list.
 * docs/changelog/2026-10-12-a-late-ticket-entry-wakes-its-manager.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DIR = 'supabase/migrations';
const FILE = '20261012112543_a_late_ticket_entry_wakes_its_manager.sql';
const ALLOWLIST_FILE = '20260908042000_bounty_elimination_outbox_is_atomic_and_recoverable.sql';
const migration = readFileSync(`${DIR}/${FILE}`, 'utf8');
const allowlistSource = readFileSync(`${DIR}/${ALLOWLIST_FILE}`, 'utf8');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

const WAKE_REASONS = [
  'rebuy',
  'reentry',
  'addon',
  'late_registration',
  'deal_vote',
  'bounty_settled',
];
const WAKE_CALL = /fn_emit_tournament_manager_wake\(\s*[a-z_.]+\s*,\s*'([a-z_]+)'/g;

describe('a late ticket entry wakes its manager with a reason the door knows', () => {
  it('is recorded byte-exact as applied', () => {
    expect(md5(migration)).toBe('05b72d58c20392ca21127a1bec4d688c');
  });

  it('the wake door and its table admit exactly the closed list of reasons', () => {
    const list = WAKE_REASONS.map((r) => `'${r}'`).join(',');
    expect(allowlistSource).toContain(`CHECK (reason IN (${list}))`);
    expect(allowlistSource).toMatch(
      /IF p_reason NOT IN \(\s*'rebuy','reentry','addon','late_registration','deal_vote','bounty_settled'\s*\) THEN\s+RAISE EXCEPTION 'invalid tournament manager wake reason'/
    );
  });

  it('replaces the one unknown reason in the ticket door with late_registration', () => {
    const anchor = migration.slice(
      migration.indexOf('v_anchor constant text'),
      migration.indexOf('v_new constant text')
    );
    const replacement = migration.slice(
      migration.indexOf('v_new constant text'),
      migration.indexOf('d text; n text;')
    );
    expect(anchor).toContain("p_tournament_id,'late_ticket_registration');");
    expect(replacement).toContain("p_tournament_id,'late_registration');");
    expect(replacement).not.toContain("'late_ticket_registration'");
    expect(migration).toContain(
      "(length(d) - length(replace(d, v_anchor, ''))) / length(v_anchor) <> 1"
    );
    expect(migration).toContain("v_pre constant text := '5f8d1cd44ebfa063291401da00597e8a'");
    expect(migration).toContain(
      "@live-proof: md5(pg_get_functiondef('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure)) = 'bf8a5f20ef63427093a662c62edc5d65'"
    );
    expect(migration).toMatch(/BEGIN;\nSET LOCAL lock_timeout = '5s';[\s\S]*COMMIT;\n$/);
    expect(migration).toContain('proacl IS NOT DISTINCT FROM acl_before');
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE|INSERT INTO|DELETE FROM|UPDATE public\.)\b/);
  });

  it('proves on apply that no function in the catalog wakes with an unknown reason', () => {
    const prove = migration.slice(migration.indexOf('DO $prove$'));
    expect(prove).toContain(
      "m[1] NOT IN ('rebuy','reentry','addon','late_registration','deal_vote','bounty_settled')"
    );
    expect(prove).toContain('LATE_TICKET_WAKE_RESULT_CHANGED');
  });

  it('no later migration hands the wake door a reason outside its list', () => {
    const later = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .sort();
    const offenders: string[] = [];
    for (const f of later) {
      const src = readFileSync(`${DIR}/${f}`, 'utf8');
      for (const m of src.matchAll(WAKE_CALL)) {
        if (!WAKE_REASONS.includes(m[1])) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the engine acts on the late_registration wake the door now emits', () => {
    const eliminations = readFileSync(
      'server/src/tournament/TournamentManagerEliminations.ts',
      'utf8'
    );
    expect(eliminations).toContain("(reason) => reason === 'late_registration'");
  });
});
