/**
 * ===========================================================================
 *  LAW: A LIVE TABLE KEEPS THE BOUNDARY ITS MOVEMENT READS, AND AN ACCEPTED
 *  PERMIT IS ITS OWN WITNESS
 * ===========================================================================
 *
 * F06 player movement is a PERMANENT obligation proved from two records per
 * hand, and until 2026-09-25 only ONE of the two records was permanent.
 *
 *   smarter_private.f06_movement_permits reads every permit the table ever
 *   held and, for state='accepted', re-derived the seal out of
 *   public.hand_atomic_commits. A bare `a.hand_id IS NULL` was enough to raise
 *   F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY.
 *
 *   smarter_private.f06_movement_prior reads the table's LAST commit (max
 *   hand_number) plus its public.hand_history row, and validates the
 *   post-commit payload hash, the request hash and the whole stack receipt out
 *   of that one row. NOT FOUND raises F06_MOVEMENT_PRIOR_INCOMPLETE.
 *
 * public.sp_prune_hand_history deletes BOTH of those tables at
 * hand_history_retention_policy.horse_retention_days - eight days, Dan's
 * storage decision of 2026-09-17 and the single sanctioned asymmetry in
 * CLAUDE.md 10.5. Its one F06 guard, f06_hand_cards_unresolved(table, hand),
 * retained the hand whose OWN permit was still 'reserved': the hand that never
 * started, which has no history row to retain. The hands the table had ALREADY
 * DEALT were not covered at all.
 *
 * MEASURED, 2026-09-25 20:34-20:55 UTC. Nothing had been lost yet - of
 * 1,148,364 'accepted' permits, ZERO were missing their commit row. But 649
 * hand_history rows at EIGHT tables already satisfied every clause of the
 * candidate set, and one of them was max(hand_number) in hand_atomic_commits
 * for its table: table 66b1cb1d-5056-41c1-a951-1bd078f8276f hand 12114088, in
 * a RUNNING $100 freeroll, one player still seated, one non-terminal
 * f06_operations row - a movement pending since 2026-09-17 that this row was
 * the only surviving proof for. The job runs every ten minutes and was measured
 * deleting 10,000 rows a run with 54,048 ahead of that row: six runs, about
 * 21:53 UTC, and from then on that table could never complete a movement
 * again. A wider crossing followed at 2026-09-26 02:03:20 UTC as the oldest
 * accepted-permit-backed hand turned eight days old.
 *
 * WHY BOTH HALVES. Neither alone lands the fix (CLAUDE.md 10.86 rule 4):
 * the permit half bites a HEALTHY long-running table whose custody is fully
 * resolved, and the boundary half bites a STALLED table whose permits are all
 * decided. So this law pins both.
 *
 * WHAT IT MUST NOT BE READ AS. It is not a licence to relax retention, and it
 * is not "pass when the evidence is missing" (10.86 rule 1). An accepted
 * permit is immutable (F06_HAND_IDENTITY_IMMUTABLE / F06_HISTORY_IMMUTABLE)
 * and is written only by writers that verified post_commit_completed_at, so it
 * is a POSITIVE surviving witness - and a commit row that is present must
 * still pass every original check, while a DIFFERENT commit occupying the
 * permit's coordinate must still refuse.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIG_DIR = path.join('supabase', 'migrations');

const MIGRATIONS = fs
  .readdirSync(path.join(ROOT, MIG_DIR))
  .filter((f) => f.endsWith('.sql'))
  .sort();

const BODY = new Map<string, string>(
  MIGRATIONS.map((f) => [f, fs.readFileSync(path.join(ROOT, MIG_DIR, f), 'utf8')])
);

/**
 * The LAST migration (by version) that redefines a function is the one that is
 * live. Pinning the current definer rather than a hardcoded filename is what
 * stops a later redefinition from quietly undoing any of this.
 */
function currentDefiner(qualified: string): string {
  const [schema, name] = qualified.split('.');
  const re = new RegExp(
    String.raw`create\s+or\s+replace\s+function\s+(?:${schema}\s*\.\s*)?"?${name}"?\s*\(`,
    'i'
  );
  const definers = MIGRATIONS.filter((f) => re.test(BODY.get(f) as string));
  expect(definers.length, `${qualified} must be defined by a migration`).toBeGreaterThan(0);
  return definers[definers.length - 1];
}

describe('a live table keeps the boundary its movement reads', () => {
  it('scans a real migration tree (an empty sweep must not read as a pass)', () => {
    // CLAUDE.md 10.86 rule 2.
    expect(MIGRATIONS.length).toBeGreaterThan(1000);
  });

  describe('the boundary guard exists, and the retention job is its reader', () => {
    it('smarter_private.f06_movement_boundary_retained is defined, STABLE and SECURITY DEFINER', () => {
      const file = currentDefiner('smarter_private.f06_movement_boundary_retained');
      const body = BODY.get(file) as string;
      const decl = body.slice(
        body.toLowerCase().indexOf('function smarter_private.f06_movement_boundary_retained')
      );
      expect(/\bstable\b/i.test(decl.slice(0, 400)), `${file}: the guard must be STABLE`).toBe(
        true
      );
      expect(
        /security\s+definer/i.test(decl.slice(0, 400)),
        `${file}: the guard must be SECURITY DEFINER - sp_prune_hand_history is SECURITY ` +
          'INVOKER and its search_path does not include smarter_private'
      ).toBe(true);
    });

    it("it is keyed on the table's LAST committed hand, which is the row f06_movement_prior loads", () => {
      const file = currentDefiner('smarter_private.f06_movement_boundary_retained');
      const body = BODY.get(file) as string;
      expect(
        /max\s*\(\s*a?\.?hand_number\s*\)[\s\S]{0,200}hand_atomic_commits/i.test(body) ||
          /hand_atomic_commits[\s\S]{0,400}max\s*\(\s*\w*\.?hand_number\s*\)/i.test(body),
        `${file}: the guard must select max(hand_number) from hand_atomic_commits. ` +
          'f06_movement_prior loads exactly that row and validates its post-commit payload ' +
          'hash, request hash and stack receipt out of it; nothing else can reconstruct it.'
      ).toBe(true);
    });

    it('the retention job consults it inside the candidate set', () => {
      // CLAUDE.md 10.86 rule 3: a guard must have a named reader. This one's
      // reader is the retention job, and it is the ONLY reason the guard exists.
      const file = currentDefiner('public.sp_prune_hand_history');
      const body = BODY.get(file) as string;
      expect(
        /and\s+not\s+smarter_private\s*\.\s*f06_movement_boundary_retained\s*\(/i.test(body),
        `${file} is the current definer of the retention job and must exclude a live table's ` +
          'movement boundary from its candidate set with ' +
          'AND NOT smarter_private.f06_movement_boundary_retained(...). Without it the job ' +
          'deletes the only proof of a pending movement and that table raises ' +
          'F06_MOVEMENT_PRIOR_INCOMPLETE for ever.'
      ).toBe(true);
    });

    it('the unresolved-hand guard that came first is still there too', () => {
      const file = currentDefiner('public.sp_prune_hand_history');
      expect(
        /and\s+not\s+smarter_private\s*\.\s*f06_hand_cards_unresolved\s*\(/i.test(
          BODY.get(file) as string
        ),
        `${file}: the boundary guard ADDS to f06_hand_cards_unresolved; it does not replace it. ` +
          'They cover different rows - the hand that never started, and the last hand dealt.'
      ).toBe(true);
    });

    it("retention still reads the policy row, so eight days stays Dan's to change", () => {
      // CLAUDE.md 10.5: the horse-only retention window is a config row, not
      // code. A literal interval here would take that decision away from him.
      const file = currentDefiner('public.sp_prune_hand_history');
      expect(
        /horse_retention_days[\s\S]{0,200}hand_history_retention_policy/i.test(
          BODY.get(file) as string
        ),
        `${file}: the window must come from hand_history_retention_policy.horse_retention_days`
      ).toBe(true);
    });

    it('retention still prunes both of the impermanent witnesses', () => {
      // The premise of this whole law. If the job ever stops deleting these,
      // the reasoning above needs rereading before anything here is relaxed -
      // the same shape as the-permit-ledger-outlives-the-hand.
      const file = currentDefiner('public.sp_prune_hand_history');
      const body = BODY.get(file) as string;
      for (const table of ['hand_atomic_commits', 'hand_history']) {
        expect(
          new RegExp(String.raw`delete\s+from\s+(?:public\s*\.\s*)?"?${table}"?`, 'i').test(body),
          `${file} is expected to prune ${table}`
        ).toBe(true);
      }
    });
  });

  describe('an accepted permit is its own witness', () => {
    const acceptedArm = () => {
      const file = currentDefiner('smarter_private.f06_movement_permits');
      const body = BODY.get(file) as string;
      const from = body.search(/when\s+h\.state\s*=\s*'accepted'\s+then/i);
      expect(from, `${file}: the accepted arm must be present`).toBeGreaterThan(-1);
      const to = body.search(/when\s+h\.state\s+in\s*\(\s*'never_started'/i);
      expect(to, `${file}: the never_started arm must follow it`).toBeGreaterThan(from);
      return { file, arm: body.slice(from, to) };
    };

    it('an absent commit row is no longer, on its own, a permanent refusal', () => {
      const { file, arm } = acceptedArm();
      expect(
        /\bor\s+a\.hand_id\s+is\s+null\s+or\b/i.test(arm),
        `${file}: the accepted arm must not refuse on a bare "OR a.hand_id IS NULL OR". ` +
          'hand_atomic_commits is deleted by retention at eight days, so that clause turns ' +
          'every table holding an eight-day-old accepted permit permanently unmovable.'
      ).toBe(false);
    });

    it('a commit row that IS present is still checked exactly as before', () => {
      const { file, arm } = acceptedArm();
      expect(
        /a\.hand_id\s+is\s+not\s+null\s+and\s*\(/i.test(arm),
        `${file}: the post-commit checks must be guarded by "a.hand_id IS NOT NULL AND (" - ` +
          'present evidence is verified, it is never skipped'
      ).toBe(true);
      for (const clause of [
        'post_commit_completed_at',
        'isfinite',
        'committed_at',
        'post_commit_result',
      ]) {
        expect(arm.includes(clause), `${file}: the accepted arm must still check ${clause}`).toBe(
          true
        );
      }
    });

    it('the permit itself must carry evidence, so "I could not tell" still refuses', () => {
      // CLAUDE.md 10.86 rule 1. An accepted permit with no evidence_id is a
      // state neither writer can produce, so it is not a pruned hand - it is
      // an unreadable one, and it refuses.
      const { file, arm } = acceptedArm();
      expect(
        /h\.evidence_id\s+is\s+null/i.test(arm),
        `${file}: the accepted arm must refuse when h.evidence_id IS NULL`
      ).toBe(true);
    });

    it("a DIFFERENT commit occupying the permit's coordinate still refuses", () => {
      // The case the old bare test was really catching, and the reason absence
      // is not simply trusted: an empty coordinate is retention, a contested
      // one is an identity conflict.
      const { file, arm } = acceptedArm();
      expect(
        /a\.hand_id\s+is\s+null\s+and\s+exists\s*\([\s\S]{0,300}hand_atomic_commits/i.test(arm),
        `${file}: when no commit row matches the permit's own evidence, the arm must still ` +
          'refuse if some other commit exists at (table_id, hand_number)'
      ).toBe(true);
    });

    it('the boundary and the reserved/unknown refusals are untouched', () => {
      const file = currentDefiner('smarter_private.f06_movement_permits');
      const body = BODY.get(file) as string;
      expect(
        /h\.hand_number\s*>\s*p_boundary/i.test(body),
        `${file}: an accepted permit above the movement boundary must still refuse`
      ).toBe(true);
      expect(
        /else\s+true\s+end/i.test(body),
        `${file}: the CASE must still default to refusing - 'reserved' and any unknown state`
      ).toBe(true);
      expect(
        /f06_hand_dispatch/i.test(body),
        `${file}: an in-flight dispatch must still refuse movement`
      ).toBe(true);
    });
  });
});
