/**
 * LAW: A REAL ALERT REACHES THE OWNER (launch audit, 2026-10-07).
 *
 * Every Club Arena operational alert lands in operational_alert_events, an
 * inbox nobody had read since 2026-10-01. 1,574 rows in 48 hours, all unread,
 * and the three things a person must hear about - tables that stop dealing, an
 * engine restart storm, a money check that fails - were buried in them.
 *
 * What this pins:
 *   1. Exactly those three kinds page; warnings, recoveries, mirror copies and
 *      one-minute flickers stay in the inbox.
 *   2. A page goes through the ordinary 'system' notification and push path to
 *      the senior platform recipients, under a title that can never be diverted
 *      back into the unread inbox. Nothing new is configured and no job exists.
 *   3. Within a kind a repeat is held until 3 quiet hours (a new episode), with
 *      one reminder every 12 hours while it keeps firing, and the next page says
 *      how many were held.
 *   4. The page can never fail the capture of the alert.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20261007000420_a_real_alert_reaches_the_owner.sql'),
  'utf8'
);
const code = MIG.replace(/--[^\n]*/g, ' ');

describe('a real alert reaches the owner', () => {
  it('is one transaction with a live proof and named refusals', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    expect(MIG).toMatch(/^-- @live-proof: \(SELECT EXISTS/m);
    for (const c of ['PREIMAGE_CHANGED', 'PAGE_WOULD_BE_DIVERTED', 'RESULT_CHANGED'])
      expect(MIG).toContain('REAL_ALERT_' + c);
  });

  it('pages only the three kinds a person must hear about', () => {
    expect(code).toMatch(/THEN 'dealing'/);
    expect(code).toMatch(/THEN 'restarts'/);
    expect(code).toMatch(/THEN 'money'/);
    for (const name of [
      'SLOTableHasStalled',
      'MttPlayStopped',
      'TournamentNeverStarted',
      'ClubArenaEngineKillStorm',
    ])
      expect(code).toContain(`'${name}'`);
    // Self-clearing flickers and the post-break availability dip are noise.
    expect(code).not.toMatch(/IN \([^)]*'PokerTablesFrozen'/);
    expect(code).not.toMatch(/IN \([^)]*'SLOEngineAvailability'/);
    expect(code).toContain(
      "fn_ca_owner_page_kind('alertmanager', 'PokerTablesFrozen', 'critical') IS NOT NULL"
    );
    // Money pages only what already passed the critical-only incident gate.
    expect(code).toMatch(
      /p_source = 'owner-operational-notifications' AND p_severity = 'critical'/
    );
  });

  it('fires on a new firing row only, through the ordinary notification path', () => {
    expect(code).toMatch(
      /AFTER INSERT ON public\.operational_alert_events\s+FOR EACH ROW\s+WHEN \(NEW\.status = 'firing'\)/
    );
    expect(code).toMatch(/PERFORM public\.fn_raise_notification\(\s+v_rec, 'system', v_title,/);
    expect(code).toMatch(/r\.scope = 'platform' AND r\.active AND r\.senior/);
    expect(code).not.toMatch(/cron\.schedule|CREATE\s+EXTENSION/i);
  });

  it('holds repeats: 3 quiet hours is a new episode, 12 hours is a reminder', () => {
    expect(code).toContain("c_new_episode CONSTANT interval := interval '3 hours';");
    expect(code).toContain("c_reminder CONSTANT interval := interval '12 hours';");
    expect(code).toMatch(/v_now - v_state\.last_firing_at >= c_new_episode/);
    expect(code).toMatch(/v_now - v_state\.last_paged_at >= c_reminder/);
    expect(code).toMatch(/held_since_page = held_since_page \+ 1/);
    expect(code).toMatch(/FOR UPDATE;/);
  });

  it('cannot be diverted into the unread inbox and cannot fail the capture', () => {
    // The 'component' key would make fn_is_owner_operational_notification divert it.
    expect(code).not.toMatch(/'component'/);
    expect(code).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'fn_ca_a_real_alert_reaches_the_owner failed/
    );
    expect(MIG).not.toContain(String.fromCharCode(0x2014));
  });
});
