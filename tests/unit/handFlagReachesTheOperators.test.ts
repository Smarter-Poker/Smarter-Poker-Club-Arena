/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PHASE 6 — a flagged hand reaches the operators, and comes back with an answer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The behaviour that matters here lives in Postgres, and it was verified there
 * against production inside one self-aborting transaction (CLAUDE.md 11.5) -
 * a player flagged their own hand, a player could not resolve it, closing it
 * with no note was refused, an operator of another club read zero rows, and
 * the whole thing rolled back leaving `ca_hand_flags` empty and `audit_trail`
 * at the count it started with.
 *
 * What these pins hold is the shape the CLIENT cannot get wrong on its own:
 * the service asks for nothing it should not, the migration says what it
 * should, and the surfaces that let a player flag a hand are the ones a player
 * is actually in.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sliceCall } from '../helpers/sourceWindow';

const ROOT = resolve(__dirname, '../..');
const migrationText = (needle: string): string => {
  const dir = join(ROOT, 'supabase/migrations');
  const file = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse()
    .find((f) => readFileSync(join(dir, f), 'utf8').includes(needle));
  return file ? readFileSync(join(dir, file), 'utf8') : '';
};

describe('a flag is filed by the player and answered by the club', () => {
  const flagsSql = migrationText('CREATE TABLE IF NOT EXISTS public.ca_hand_flags');

  it('the table exists, with RLS and no write policy at all', () => {
    expect(flagsSql).toBeTruthy();
    expect(flagsSql).toMatch(/ALTER TABLE public\.ca_hand_flags ENABLE ROW LEVEL SECURITY/);
    /* READS are policies; WRITES are definer functions only. A client that
       could INSERT would choose its own `club_id` and put a flag in front of
       operators with no business seeing it. */
    expect(flagsSql).toMatch(/CREATE POLICY ca_hand_flags_select_own/);
    expect(flagsSql).toMatch(/CREATE POLICY ca_hand_flags_select_staff/);
    expect(flagsSql).not.toMatch(
      /CREATE POLICY[^;]*ca_hand_flags[\s\S]*?FOR\s+(INSERT|UPDATE|DELETE)/i
    );
    expect(flagsSql).toMatch(/GRANT SELECT ON public\.ca_hand_flags TO authenticated/);
    expect(flagsSql).toMatch(/REVOKE ALL ON public\.ca_hand_flags FROM PUBLIC, anon/);
  });

  it('you can only flag a hand you were dealt into, and the club comes from the hand', () => {
    /* The same predicate `hand_history`'s own SELECT policy uses. It is
       restated inside the definer function because RLS does not apply there -
       the check is explicit or it is not made at all. */
    expect(flagsSql).toMatch(/players @> jsonb_build_array\(jsonb_build_object\('userId'/);
    expect(flagsSql).toMatch(/not yours to flag/i);
    expect(flagsSql).toMatch(/SELECT t\.club_id INTO v_club FROM public\.tables t/);
  });

  it('closing a flag needs a note the player can read', () => {
    expect(flagsSql).toMatch(/p_status IN \('resolved', 'dismissed'\) AND v_note IS NULL/);
    expect(flagsSql).toMatch(/needs a note the player can read/i);
  });

  it('resolving a flag writes an audit row', () => {
    const resolveFn = flagsSql.slice(flagsSql.indexOf('FUNCTION public.fn_ca_resolve_hand_flag'));
    expect(resolveFn).toMatch(/INSERT INTO public\.audit_trail/);
    expect(resolveFn).toMatch(/'hand_flag_' \|\| p_status/);
  });

  it('triage is staff and the cards are control, and the two sets differ', () => {
    const staff = flagsSql.slice(
      flagsSql.indexOf('FUNCTION public.fn_ca_is_club_staff'),
      flagsSql.indexOf('FUNCTION public.fn_ca_is_club_control')
    );
    const control = flagsSql.slice(flagsSql.indexOf('FUNCTION public.fn_ca_is_club_control'));
    expect(staff).toMatch(/'manager'/);
    expect(staff).toMatch(/'super_agent'/);
    expect(staff).toMatch(/'agent'/);
    /* The control set is owner/co_owner/admin ONLY. An agent seeing every
       hole card at the club is the failure this separation exists to stop. */
    const controlRoles = control.slice(0, control.indexOf('$$;'));
    expect(controlRoles).toMatch(/'owner', 'co_owner', 'admin'/);
    expect(controlRoles).not.toMatch(/'manager'/);
    expect(controlRoles).not.toMatch(/'super_agent'/);
  });

  it('both card stores are read, so a disputed hand is not empty', () => {
    const sql = migrationText('FUNCTION public.fn_ca_operator_read_hand');
    expect(sql).toMatch(/ca_hand_facts/);
    expect(sql).toMatch(/table_hole_cards/);
  });
});

describe('the client asks for no more than it should', () => {
  const service = readFileSync(join(ROOT, 'src/services/HandFlagService.ts'), 'utf8');

  it('never sends a user id, because RLS decides whose rows these are', () => {
    /* The same reason `HandNotesService` takes none: a service that can name
       a user can be called with the wrong one. */
    expect(service).not.toMatch(/p_user_id/);
    expect(service).not.toMatch(/userId\s*:/);
  });

  it('asks for the caller’s flags BY HAND ID, not "my newest N"', () => {
    const call = sliceCall(service, 'mineFor(');
    expect(service).toMatch(/\.in\('hand_id', ids\.slice/);
    expect(call).toMatch(/handIds/);
  });

  it('refuses to send a godmode read without a reason, before the round trip', () => {
    expect(service).toMatch(/GODMODE_REASON_MIN/);
    expect(service).toMatch(/Say Why This Hand Is Being Opened/);
  });

  it('carries the database’s own refusals through as words a person can act on', () => {
    expect(service).toMatch(/Only A Club Owner Or Admin May Open A Hand/);
    expect(service).toMatch(/That Hand Was Not Dealt At This Club/);
  });
});

describe('the flag control is on the surfaces a player is actually in', () => {
  it('the archive and the table panel both mount it', () => {
    for (const file of [
      'src/pages/HandHistoryPage.tsx',
      'src/components/table/HandHistoryPanel.tsx',
    ]) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src, `${file} imports the control`).toMatch(/HandFlagControl/);
      expect(src, `${file} loads the caller's flags`).toMatch(/handFlagService\.mineFor\(/);
    }
  });

  it('the operator page is registered everywhere a page has to be', () => {
    const integrity = readFileSync(join(ROOT, 'src/config/clubIntegrityNavigation.ts'), 'utf8');
    const operations = readFileSync(join(ROOT, 'src/config/clubOperationsNavigation.ts'), 'utf8');
    const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
    /* A definition without its suffix means no route-level permission check
       AND a vanished operations rail - the trap the registry test was written
       about. All four, or the page is half-wired. */
    expect(integrity).toMatch(/'hand-review'/);
    expect(operations).toMatch(/suffix: 'hand-review'/);
    expect(operations).toMatch(/'hand-review',/);
    expect(app).toMatch(/clubs\/:clubId\/hand-review/);
  });

  it('the page says the read is logged, in words, before it is used', () => {
    const page = readFileSync(join(ROOT, 'src/pages/ClubHandReviewPage.tsx'), 'utf8');
    expect(page).toMatch(/Written To The Club Audit Trail/i);
    expect(page).toMatch(/This Read Was Logged To The Club Audit Trail/);
    /* And it never presents a short record as a complete one. */
    expect(page).toMatch(/Holdings On Record/);
    expect(page).toMatch(/Their Holdings Are No Longer On\s*\n?\s*Record/);
  });
});
