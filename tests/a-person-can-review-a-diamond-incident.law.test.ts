/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A PERSON CAN REVIEW A DIAMOND INCIDENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 4, the incident review piece.
 * Platform staff read ca_diamond_incidents by status, rule and severity, and
 * acknowledge, comment on, resolve and reopen a row, or close a whole rule
 * family in one act, with a written reason; every act names its reviewer on
 * the row and in an append-only trail that outlives the row.
 *
 * A person's answer and the watches never fight: the watches close only open
 * rows and never name a person, so a row a person resolved is never closed a
 * second time and a row a watch closes records "auto" as it always did; and a
 * trigger keeps a machine from rewriting a person's resolution or closing a
 * row a person reopened. The migration changes no function it did not create,
 * reviews nothing and opens no switch.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus, migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_person_can_review_a_diamond_incident.sql'))
  .at(-1);
if (!NAME) throw new Error('the incident review migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const TRAIL = section('-- 1. THE TRAIL', '-- 2. THE ROW NAMES ITS REVIEWER');
const ROW = section(
  '-- 2. THE ROW NAMES ITS REVIEWER',
  '-- 3. A PERSON AND THE WATCHES DO NOT FIGHT'
);
const HOLD = section(
  '-- 3. A PERSON AND THE WATCHES DO NOT FIGHT',
  '-- 4. WHAT A ROW SAYS TO STAFF'
);
const JSON_ROW = section('-- 4. WHAT A ROW SAYS TO STAFF', '-- 5. THE BOARD');
const BOARD = section('-- 5. THE BOARD', '-- 6. THE TRAIL OF ONE ROW');
const TRAIL_DOOR = section('-- 6. THE TRAIL OF ONE ROW', '-- 7. THE REVIEW DOOR');
const REVIEW = section('-- 7. THE REVIEW DOOR', '-- 8. A WHOLE FAMILY IN ONE ACT');
const FAMILY = section('-- 8. A WHOLE FAMILY IN ONE ACT', '-- 9. GRANTS');
const GRANTS = section('-- 9. GRANTS', '-- 10. EVERY PIECE IS IN PLACE');
const FINAL = code(section('-- 10. EVERY PIECE IS IN PLACE', 'RAISE NOTICE'));

const NEW_FUNCTIONS = [
  'fn_ca_diamond_incident_events_append_only',
  'fn_ca_diamond_incident_person_hold',
  'fn_ca_diamond_incident_actor_label',
  'fn_ca_diamond_incident_json',
  'fn_ca_diamond_incident_board',
  'fn_ca_diamond_incident_trail',
  'fn_ca_diamond_incident_review',
  'fn_ca_diamond_incident_resolve_family',
];
const DOORS = [BOARD, TRAIL_DOOR, REVIEW, FAMILY];

/** The body of the latest definition of a function anywhere in the corpus. */
function latestBody(fn: string): string {
  const head = new RegExp(
    `CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?\\bAS (\\$\\w*\\$)`,
    'g'
  );
  let body = '';
  for (const { sql } of migrationCorpus()) {
    for (const m of sql.matchAll(head)) {
      const start = (m.index ?? 0) + m[0].length;
      body = sql.slice(start, sql.indexOf(m[1], start));
    }
  }
  if (!body) throw new Error(`${fn} has no definition in the corpus`);
  return body;
}

describe('LAW: a person can review a Diamond incident', () => {
  it('reviews nothing, opens nothing and changes no function it did not create', () => {
    const created = [...MIG.matchAll(/^CREATE (OR REPLACE )?FUNCTION public\.(\w+)\(/gm)];
    expect(created.map((m) => m[2]).sort()).toEqual([...NEW_FUNCTIONS].sort());
    expect(created.every((m) => m[1] === undefined)).toBe(true);
    expect(code(MIG)).not.toMatch(/(tournaments_enabled|cash_games_enabled)\s*=\s*true/i);
    expect(FINAL).toContain('this migration must not review any incident');
    expect(FINAL).toContain('this migration must not open a switch');
    expect(FINAL).toContain('watched guards off their baseline');
    // Outside the doors' bodies nothing writes an incident row.
    const outsideBodies = MIG.replace(/AS \$\$[\s\S]*?\$\$;/g, ' ');
    expect(code(outsideBodies)).not.toMatch(/UPDATE\s+public\.ca_diamond_incidents\b/);
  });

  it('keeps an append-only trail that outlives the row it describes', () => {
    expect(TRAIL).toContain('CREATE TABLE public.ca_diamond_incident_events');
    expect(code(TRAIL)).not.toMatch(/\bREFERENCES\b/);
    expect(TRAIL).toContain("CHECK (kind IN ('acknowledged', 'comment', 'resolved', 'reopened'))");
    expect(TRAIL).toMatch(
      /BEFORE UPDATE OR DELETE ON public\.ca_diamond_incident_events\s+FOR EACH ROW/
    );
    expect(TRAIL).toMatch(
      /BEFORE TRUNCATE ON public\.ca_diamond_incident_events\s+FOR EACH STATEMENT/
    );
    expect(TRAIL).toContain(
      'REVOKE ALL ON TABLE public.ca_diamond_incident_events FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(TRAIL).toContain(
      'GRANT SELECT ON TABLE public.ca_diamond_incident_events TO service_role;'
    );
    expect(FINAL).toContain("contype = 'f'");
  });

  it('names the reviewer on the row and in the trail, for every act', () => {
    for (const col of [
      'acknowledged_at',
      'acknowledged_by',
      'resolved_by',
      'reopened_at',
      'reopened_by',
    ])
      expect(ROW).toContain(`ADD COLUMN ${col}`);
    expect(REVIEW).toContain('SET acknowledged_at = now(), acknowledged_by = v_uid');
    expect(REVIEW).toContain('SET resolved_at = now(), resolved_by = v_uid, resolution = v_note');
    expect(REVIEW).toContain('reopened_at = now(), reopened_by = v_uid');
    expect(REVIEW).toMatch(/INSERT INTO public\.ca_diamond_incident_events[\s\S]*v_uid, v_label/);
    expect(FAMILY).toContain('SET resolved_at = now(), resolved_by = v_uid, resolution = v_note');
    expect(FAMILY).toContain("'act', v_act");
    // A reason is written: at least 10 characters to resolve, reopen or close a family.
    expect(REVIEW).toContain(
      "p_action IN ('resolve', 'reopen') AND COALESCE(length(v_note), 0) < 10"
    );
    expect(FAMILY).toContain('COALESCE(length(v_note), 0) < 10');
    // A family act closes what the reviewer saw and leaves a reopened row alone.
    expect(FAMILY).toContain('i.occurred_at <= v_before');
    expect(FAMILY).toContain('AND i.reopened_by IS NULL');
  });

  it('opens every door to platform staff only, and a review to a person only', () => {
    for (const door of DOORS) {
      expect(door).toContain('NOT public.fn_is_platform_admin()');
      expect(door).toContain("'error', 'staff_required'");
      expect(door).toContain('SECURITY DEFINER');
    }
    for (const door of [REVIEW, FAMILY])
      expect(door).toMatch(
        /IF v_uid IS NULL THEN\s+RETURN jsonb_build_object\('success', false, 'error', 'authentication_required'\)/
      );
    expect(GRANTS).toMatch(/FROM PUBLIC, anon, authenticated, service_role;/);
    const grant = GRANTS.slice(GRANTS.indexOf('GRANT EXECUTE'));
    expect(code(grant)).toMatch(/TO authenticated, service_role;\s*$/);
    expect(grant).not.toMatch(/\banon\b/);
    for (const door of ['board', 'trail', 'review', 'resolve_family'])
      expect(grant).toContain(`public.fn_ca_diamond_incident_${door}(`);
    for (const helper of ['actor_label', 'json(', 'person_hold', 'events_append_only'])
      expect(grant).not.toContain(`fn_ca_diamond_incident_${helper}`);
  });

  it('holds a person answer against every machine, and lets the doors through', () => {
    expect(HOLD).toMatch(
      /BEFORE UPDATE ON public\.ca_diamond_incidents\s+FOR EACH ROW WHEN \(OLD\.resolved_by IS NOT NULL OR OLD\.reopened_by IS NOT NULL\)/
    );
    expect(HOLD).toContain(
      "IF current_setting('ca.diamond_incident_review', true) = 'person' THEN"
    );
    expect(HOLD).toMatch(
      /IF OLD\.resolved_by IS NOT NULL\s+AND \(NEW\.resolved_at, NEW\.resolved_by, NEW\.resolution\)\s+IS DISTINCT FROM \(OLD\.resolved_at, OLD\.resolved_by, OLD\.resolution\) THEN\s+RETURN NULL;/
    );
    expect(HOLD).toMatch(
      /IF OLD\.resolved_at IS NULL AND OLD\.reopened_by IS NOT NULL AND NEW\.resolved_at IS NOT NULL THEN\s+RETURN NULL;/
    );
    expect(code(HOLD)).not.toMatch(/RAISE EXCEPTION/);
    // Each door raises the flag for its own UPDATE and lowers it straight after.
    for (const door of [REVIEW, FAMILY]) {
      const up = door.match(/set_config\('ca\.diamond_incident_review', 'person', true\)/g) ?? [];
      const down = door.match(/set_config\('ca\.diamond_incident_review', '', true\)/g) ?? [];
      expect(up.length).toBeGreaterThan(0);
      expect(down.length).toBe(up.length);
    }
    // Only the review door re-opens a row, and the migration asserts it live.
    expect(REVIEW).toContain('SET resolved_at = NULL, resolved_by = NULL, resolution = NULL');
    expect(FINAL).toContain('something besides the review door re-opens a Diamond incident');
  });

  it('shows who closed a row: a person, a watch that wrote auto, or no record', () => {
    expect(JSON_ROW).toContain("WHEN p.resolved_by IS NOT NULL THEN 'person'");
    expect(JSON_ROW).toContain("WHEN p.resolution LIKE 'auto:%' THEN 'watch'");
    expect(JSON_ROW).toContain("ELSE 'unrecorded' END");
    expect(BOARD).toContain("WHEN 'unresolved' THEN i.resolved_at IS NULL");
    expect(BOARD).toContain("split_part(i.rule, ':', 1)");
    expect(BOARD).toContain('LIMIT v_limit + 1');
  });

  it('the watches close only open rows, write "auto", and never name a person', () => {
    for (const fn of ['fn_ca_diamond_health_watch', 'fn_ca_diamond_trial_balance_watch']) {
      const body = latestBody(fn);
      // A statement ends at a semicolon that ends its line: the health watch's
      // closing note joins its areas with '; ' inside a string.
      const updates = [
        ...body.matchAll(/UPDATE public\.ca_diamond_incidents[\s\S]*?;[ \t]*\n/g),
      ].map((m) => m[0]);
      expect(updates.length, fn).toBeGreaterThan(0);
      for (const u of updates) {
        expect(u, fn).toMatch(/resolved_at IS NULL/);
        expect(u, fn).not.toMatch(/resolved_at\s*=\s*NULL\b/);
      }
      expect(body, fn).not.toMatch(/resolved_by|reopened_by|acknowledged_by/);
    }
    expect(latestBody('fn_ca_diamond_health_watch')).toContain("resolution = 'auto: ' ||");
    expect(latestBody('fn_ca_diamond_trial_balance_watch')).toContain(
      "format('auto: account %s read difference 0 at %s'"
    );
  });
});
