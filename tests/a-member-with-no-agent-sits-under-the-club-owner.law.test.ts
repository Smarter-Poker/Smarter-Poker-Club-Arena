import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dan, 2026-10-25: "ANY 'ORPHANED' PLAYERS, OR PLAYERS WITH NO AGENTS, GET
// ASSIGNED TO THE CLUB OWNER. 'KINGFISH' FOR KINGS CLUB PLAYERS." and
// "ASSIGN ALL ORPHANED PLAYERS TO THEIR CLUB OWNER AND FIX THE JOIN PATH".
//
// The one door that creates a membership inserted every new member with no
// agent, so anybody who joined without an agent's invite was left with no
// upline. This pins the root fix in that door, the two doors that must still
// let an agent claim such a player, the deleted-agent re-homing, and the one
// settlement of the members who already had no agent.

const dir = 'supabase/migrations';
const found = readdirSync(dir).filter((name) =>
  name.endsWith('_members_with_no_agent_sit_under_the_club_owner.sql')
);
if (found.length !== 1) throw new Error('Expected One Owner Upline Migration');
const sql = readFileSync(`${dir}/${found[0]}`, 'utf8');
const code = sql.replace(/^--[^\n]*$/gm, '');

describe('a member with no agent sits under the club owner', () => {
  it('the join door inserts a non-owner member under the club owner', () => {
    expect(code).toContain(
      'INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance, agent_id)'
    );
    expect(code).toContain('CASE WHEN v_uid = v_owner THEN NULL ELSE v_owner END)');
  });

  it('an unchosen owner placement still yields to the first agent invite', () => {
    // Only a placement no invite made (invited_by NULL) is replaceable; an
    // invite's placement, the owner's own included, is never moved.
    expect(code).toMatch(
      /WHEN agent_id IS NULL\s+OR \(agent_id = \(SELECT c\.owner_id FROM clubs c WHERE c\.id = p_club_id\)\s+AND invited_by IS NULL\)/
    );
    expect(code).toMatch(/THEN coalesce\(v_effective_agent,\s+\(SELECT c\.owner_id FROM clubs c/);
    expect(code).toContain('ELSE agent_id');
  });

  it('an agent may still add a player whose only upline is the unchosen owner placement', () => {
    expect(code).toMatch(
      /AND NOT \(v_member\.agent_id = \(SELECT c\.owner_id FROM clubs c WHERE c\.id = p_club_id\)\s+AND v_member\.invited_by IS NULL\)/
    );
  });

  it("a deleted agent's downline with no live upline goes to the club owner", () => {
    expect(code).toMatch(
      /SET agent_id = CASE WHEN r\.via_agent THEN coalesce\(v_target,\s+\(SELECT c2\.owner_id FROM public\.clubs c2/
    );
  });

  it('every patch is pinned before and after, and a moved definition aborts', () => {
    for (const marker of [
      'OWNER_UPLINE_PREIMAGE_CHANGED',
      'OWNER_UPLINE_PATCH_MISMATCH',
      'OWNER_UPLINE_INSTALL_MISMATCH',
    ]) {
      expect(code.split(marker).length - 1).toBe(4);
    }
    expect(sql.match(/^-- @live-proof: md5\(pg_get_functiondef/gm)).toHaveLength(4);
  });

  it('the settlement moves players and agents, never staff, the owner, the Diamond Arena or history', () => {
    expect(code).toContain("m.role NOT IN ('owner', 'club_owner', 'co_owner', 'admin', 'club_admin')");
    expect(code).toContain("c.asset = 'chips'");
    expect(code).toContain("m.membership_lifecycle_status = 'active'");
    expect(code).toContain('m.user_id <> c.owner_id');
    // Horses are players (CLAUDE.md 10.5): nothing here may leave them out.
    expect(code).not.toMatch(/is_horse|is_bot/i);
    expect(code).toContain('OWNER_UPLINE_BACKFILL_INCOMPLETE');
  });

  it('a reassignment does not re-send the welcome text, and writes no money', () => {
    expect(code).toMatch(
      /UPDATE public\.club_messenger_admissions\s+SET transaction_id = 0\s+WHERE transaction_id = txid_current\(\);/
    );
    expect(code).not.toMatch(/SET\s+(chip_balance|promo_balance|agent_wallet_balance)\s*=/i);
    expect(code).not.toMatch(/cron\.schedule|DELETE FROM/i);
  });

  it('is one transaction', () => {
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
