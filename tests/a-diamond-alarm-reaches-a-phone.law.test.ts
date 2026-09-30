/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND ALARM REACHES A PHONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 5, item 2 of the ordered build
 * list in docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md. A critical row in
 * ca_diamond_incidents raises one drift incident per rule and episode through
 * the estate's own door, recorded in diamonds and worded in Diamonds, and the
 * recipient registry, the notify ledger, the escalation tick and the push
 * carry it. A warning or an info row pages nothing. The engine's custody
 * alerts carry the Diamonds in doubt, and the board shows a Diamond incident
 * to platform staff and its recipients only.
 *
 * The law itself - a critical Diamond row produces exactly one notification to
 * the registry, a warning produces none - was proved live before apply: the
 * rows open on 2026-09-29 (20 critical in one rule, 7,060 warning, 15,979
 * info) replayed through the trigger made one incident and one page. This
 * file pins the shapes that make it true.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_alarm_reaches_a_phone.sql'))
  .at(-1);
if (!NAME) throw new Error('the Diamond alarm migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const RAISE = section(
  '-- 1. A FINDING RECORDS ITS CURRENCY',
  "-- 2. THE PAGE SAYS DIAMONDS, AND A DIAMOND RULE'S CRITICAL GETS THROUGH"
);
const NOTIFY = section(
  "-- 2. THE PAGE SAYS DIAMONDS, AND A DIAMOND RULE'S CRITICAL GETS THROUGH",
  "-- 3. THE SUPPLY SNAPSHOT'S INCIDENT IS A DIAMOND INCIDENT"
);
const SNAPSHOT = section(
  "-- 3. THE SUPPLY SNAPSHOT'S INCIDENT IS A DIAMOND INCIDENT",
  '-- 4. THE BOARD SHOWS A DIAMOND INCIDENT TO STAFF AND ITS RECIPIENTS ONLY'
);
const BOARD = section(
  '-- 4. THE BOARD SHOWS A DIAMOND INCIDENT TO STAFF AND ITS RECIPIENTS ONLY',
  '-- 5. A CRITICAL DIAMOND ROW RAISES ONE DRIFT INCIDENT PER RULE'
);
const HOOK = section(
  '-- 5. A CRITICAL DIAMOND ROW RAISES ONE DRIFT INCIDENT PER RULE',
  '-- 6. THE SUPPLY INCIDENTS ALREADY FILED WERE ALWAYS DIAMONDS'
);
const BACKFILL = section(
  '-- 6. THE SUPPLY INCIDENTS ALREADY FILED WERE ALWAYS DIAMONDS',
  '-- 7. THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 7. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));
const CUSTODY = readFileSync(
  resolve(__dirname, '..', 'server', 'src', 'services', 'DiamondCustody.ts'),
  'utf8'
);

/** An edit in place: the live text pinned before, the reverse substitution proved after. */
const inPlace = (s: string, md5: string) => {
  expect(s).toContain(`IF md5(v_def) <> '${md5}' THEN`);
  const reversals = s.match(new RegExp(`\\) <> '${md5}' THEN`, 'g')) ?? [];
  expect(reversals.length).toBe(2);
  expect(s).toContain('occurs % times, expected 1');
  expect(code(s)).not.toContain('CREATE OR REPLACE FUNCTION');
};

describe('LAW: a Diamond alarm reaches a phone', () => {
  it('opens nothing: no switch, no settings row, no lockout', () => {
    expect(code(MIG)).not.toMatch(/ca_arena_settings\s+SET/i);
    expect(code(MIG)).not.toMatch(/(cash_games_enabled|tournaments_enabled)\s*:?=\s*true/i);
    expect(FINAL).toContain('this migration must not open an arena switch');
    expect(FINAL).toContain('a function writes the arena settings, which only a person may change');
  });

  it('the raise records the currency its metadata names and words a Diamond finding in Diamonds, chips untouched', () => {
    inPlace(RAISE, 'a6df5f2eef07aa3f606db79d93944590');
    expect(RAISE).toContain(
      "v_currency text := CASE WHEN lower(COALESCE(p_metadata->>'asset', '')) = 'diamonds'"
    );
    expect(RAISE).toContain("THEN 'diamonds' ELSE 'club_chips' END;");
    expect(RAISE).toContain('ledger_balanced, suspected_cause, metadata, currency)');
    expect(RAISE).toContain("COALESCE(p_metadata,'{}'::jsonb), v_currency)");
    expect(RAISE).toContain(
      "v_diamond_headline text := COALESCE('Diamond rule ' || (p_metadata->>'rule'), p_source)"
    );
    expect(RAISE).toContain("' Diamonds in doubt'");
    // the chip wording survives verbatim behind the currency test
    expect(RAISE).toContain(
      "ELSE v_class || ' drift ' || COALESCE(p_discrepancy,0)::text || ' chips' END,"
    );
    expect(RAISE).toContain(
      "ELSE to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ' chip drift: ' || v_class END,"
    );
    expect(MIG).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_ca_raise_drift_incident', 'migration a_diamond_alarm_reaches_a_phone');"
    );
  });

  it("the page lets a Diamond rule's critical through in Diamonds and keeps Dan's other gates", () => {
    inPlace(NOTIFY, 'ad9a51b31ec9d8f52a416e5e77a033a2');
    expect(NOTIFY).toContain(
      "v_is_diamond_rule := COALESCE(inc.source, '') = 'ca_diamond_incidents';"
    );
    expect(NOTIFY).toContain(
      'ELSIF COALESCE(inc.discrepancy_amount, 0) = 0 AND NOT v_is_liveness AND NOT v_is_diamond_rule THEN'
    );
    expect(NOTIFY).toContain(
      "THEN to_char(inc.discrepancy_amount, 'FM999999999990') || ' Diamonds in doubt. '"
    );
    expect(NOTIFY).toContain(
      "CASE WHEN inc.currency = 'diamonds' THEN 'Diamonds' ELSE 'chips' END,"
    );
    // a fix and a warning are still never a page: neither gate is in a substituted clause
    expect(code(NOTIFY)).not.toContain('a fix is not a page');
    expect(code(NOTIFY)).not.toContain('is not critical');
    expect(FINAL).toContain("v_withheld := 'a fix is not a page';");
    expect(FINAL).toContain(" is not critical';");
    expect(MIG).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_ca_incident_notify', 'migration a_diamond_alarm_reaches_a_phone');"
    );
  });

  it('the supply snapshot tags its incident, and the ones already filed are recorded in diamonds', () => {
    expect(SNAPSHOT).toContain("IF md5(v_def) <> '95b4c77768db15b19a088c5642ad47c8' THEN");
    expect(SNAPSHOT).toContain(
      "<> '95b4c77768db15b19a088c5642ad47c8' THEN\n    RAISE EXCEPTION 'fn_ca_diamond_snapshot: the reverse"
    );
    expect(SNAPSHOT).toContain(
      "false, jsonb_build_object('asset', 'diamonds', 'profile_diamonds', v_prof, 'fixture_diamonds', v_fix, 'register_supply', v_reg,"
    );
    expect(MIG).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_ca_diamond_snapshot', 'migration a_diamond_alarm_reaches_a_phone');"
    );
    expect(code(BACKFILL)).toMatch(
      /UPDATE public\.ca_drift_incidents\s+SET currency = 'diamonds'\s+WHERE source = 'fn_ca_diamond_snapshot'/
    );
    expect(FINAL).toContain('a supply snapshot incident is still recorded in chips');
  });

  it('the board shows a Diamond incident to platform staff and the recipients a Diamond incident has', () => {
    inPlace(BOARD, 'bc12882b4aaa9c4a96e1192de6a92d48');
    expect(BOARD).toContain('v_diamonds := public.fn_is_platform_admin()');
    expect(BOARD).toContain("AND r.scope IN ('platform','financial_ops','technical'));");
    expect(BOARD).toContain("AND (v_diamonds OR i.currency IS DISTINCT FROM 'diamonds')");
  });

  it('a critical row, and only a critical row, raises one incident per rule and episode through the estate door', () => {
    const body = code(HOOK);
    expect(body).toMatch(
      /CREATE TRIGGER ca_diamond_incident_critical_pages\s+AFTER INSERT ON public\.ca_diamond_incidents\s+FOR EACH ROW WHEN \(NEW\.severity = 'critical'\)\s+EXECUTE FUNCTION public\.fn_ca_diamond_incident_pages\(\);/
    );
    expect(body).toContain("p_source          => 'ca_diamond_incidents',");
    expect(body).toContain(
      "p_dedupe_key      => 'diamond-rule:' || NEW.rule || ':' || v_episode::text,"
    );
    expect(body).toMatch(
      /SELECT count\(\*\) \+ 1 INTO v_episode\s+FROM public\.ca_drift_incidents d\s+WHERE d\.source = 'ca_diamond_incidents'\s+AND d\.status = 'resolved'\s+AND d\.metadata->>'rule' = NEW\.rule;/
    );
    expect(body).toContain('p_discrepancy     => NEW.amount,');
    expect(body).toContain("'asset', 'diamonds',");
    // a platform finding: no club, union, table or event reaches the raise
    expect(body).not.toMatch(/p_(club|union|table|tournament)_id\s*=>/);
    // the row it pages for is never lost to a paging failure
    expect(body).toMatch(
      /EXCEPTION WHEN OTHERS THEN[\s\S]*INSERT INTO public\.ca_incident_file_failures/
    );
    expect(body).toMatch(/RAISE WARNING 'fn_ca_diamond_incident_pages\(%\) failed: %'/);
    // not a browser door
    expect(body).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_diamond_incident_pages() FROM PUBLIC, anon, authenticated;'
    );
    // one owned source, aged at the registry floor so a silent rule re-arms
    expect(body).toMatch(
      /INSERT INTO public\.ca_detector_registry \(source, owner, sla_hours, auto_resolve_hours, note\)\s+VALUES \('ca_diamond_incidents', 'diamond programme', 24, 24,/
    );
    expect(FINAL).toContain(
      'the critical Diamond incident trigger is not installed as this migration states'
    );
  });

  it("the engine's custody alerts carry the Diamonds in doubt", () => {
    expect(CUSTODY).toMatch(
      /'reserve',\s*\{\s*userId: input\.userId,\s*targetId: input\.targetId,\s*requestId: input\.requestId,\s*amount: input\.amount,\s*\}/
    );
    expect(CUSTODY).toMatch(
      /export async function releaseDiamondEntry\(\s*custodyId: string,\s*requestId: string,\s*amount: number\s*\)/
    );
    expect(CUSTODY).toContain("verifiedCustodyCall('release', { custodyId, requestId, amount },");
    expect(CUSTODY).toContain(
      "{ ...context, asset: 'diamonds', operation, error: describeError(error) }"
    );
  });

  it('asserts at the end that every edit landed, nothing is a browser door, the identity is whole and every watched guard is on its baseline', () => {
    expect(FINAL).toContain(
      'the raise does not record and word a Diamond finding as this migration states'
    );
    expect(FINAL).toContain('the page does not treat a Diamond incident as this migration states');
    expect(FINAL).toContain('the supply snapshot does not tag its incident as Diamonds');
    expect(FINAL).toContain(
      'the board does not keep a Diamond incident to staff and its recipients'
    );
    expect(FINAL).toContain('is reachable without an account');
    expect(FINAL).toContain('is a browser door');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });
});
