/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A PROMOTION CHOOSES THE RATE, AND STAFF EARN NONE (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "MAKE SURE THAT RAKE BACK PERCENTAGES ARE ASSIGNED WHEN
 * CREATING THEM (CO-OWNERS AND ADMINS GET NO RAKE BACK)."
 *
 * Every pin below is a bug that was live in production on the morning of
 * 2026-08-31, found by auditing the promote path end to end:
 *
 *   1. The promote screen sent a role and nothing else, and the server invented
 *      the rate - 0.50/0.30 for a super agent, 0.30/0.20 for the other two -
 *      and applied it ONLY when no agents row existed. A sub agent who had once
 *      been a super agent kept the super agent's commission.
 *   2. Nothing anywhere said a co-owner or an admin earns no rakeback. A player
 *      carrying a personal deal in club_members.player_rakeback_pct - the first
 *      branch of fn_player_rakeback_rate - kept it when promoted to admin.
 *   3. MembershipService.updateRole wrote club_members.role directly, in a role
 *      vocabulary ('club_admin', 'member', 'guest') the CHECK constraint has
 *      never accepted. Both of its callers had been failing silently.
 *   4. co_owner was a role the promote screen could grant and NOTHING could
 *      read: twenty-four authorization functions, eighteen RLS policies, the
 *      engine's only role gate and a dozen screens all asked for
 *      owner-or-admin and stopped there.
 *
 * These are source-text pins, deliberately. The behaviour they guard lives
 * across a browser, an RPC and a trigger, and a unit test cannot run all three;
 * what it CAN do is refuse to let the wiring quietly go back to what it was.
 * Each pin is anchored on the smallest durable thing - an RPC name, an argument
 * name, a helper call - rather than on phrasing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CLUB_ROLES, isAgentRole, isClubStaff, grantableRoles } from '../src/types/clubRoles';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(process.cwd(), p));

/**
 * A "must not appear" pin has to look at CODE, not at prose. Every one of these
 * files now carries a comment naming the bug it used to have, and the first
 * draft of this test failed on its own explanations.
 */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const MEMBER_MANAGEMENT = read('src/pages/MemberManagementPage.tsx');
const MEMBERSHIP_SERVICE = read('src/services/MembershipService.ts');
const CLUB_DETAIL = read('src/pages/ClubDetailPage.tsx');
const MEMBER_ADMIN = read('src/components/admin/ClubMemberManagement.tsx');
const CHIP_TRANSFER = read('src/components/agent/ChipTransferModal.tsx');
const MESSAGING = read('src/services/ClubMessagingPermissions.ts');
const SERVER_ADMIN = read('server/src/handlers/admin.ts');
const HOOKS = read('src/hooks/index.ts');

const MIGRATION_STAFF =
  'supabase/migrations/20260831235997_promotion_assigns_rakeback_and_staff_earn_none.sql';
const MIGRATION_CO_OWNER = 'supabase/migrations/20260831235996_co_owner_counts_as_club_staff.sql';

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE RATE IS CHOSEN, NOT INVENTED
// ─────────────────────────────────────────────────────────────────────────────
describe('the promote screen asks for the rate it is granting', () => {
  it('collects a commission and a player rakeback percentage', () => {
    expect(MEMBER_MANAGEMENT).toMatch(/commissionPct/);
    expect(MEMBER_MANAGEMENT).toMatch(/rakebackPct/);
  });

  it('sends both to fn_club_set_member_role', () => {
    expect(MEMBER_MANAGEMENT).toMatch(/p_commission_rate/);
    expect(MEMBER_MANAGEMENT).toMatch(/p_player_rakeback_rate/);
  });

  it('asks for them only for an agent tier', () => {
    expect(MEMBER_MANAGEMENT).toMatch(/isAgentRole\(/);
  });

  it('converts the percentage the field asks for into the fraction the column stores', () => {
    // The field says "40" and agents.commission_rate is DECIMAL(5,4) capped at
    // 0.70. Sending 40 would not merely be wrong, it would overflow the column.
    expect(MEMBER_MANAGEMENT).toMatch(/comm\s*\/\s*100/);
    expect(MEMBER_MANAGEMENT).toMatch(/rake\s*\/\s*100/);
  });

  it('refuses a rakeback larger than the commission it is paid out of', () => {
    expect(MEMBER_MANAGEMENT).toMatch(/rake\s*>\s*comm/);
  });

  it('does not pre-fill either field', () => {
    // A pre-filled rate is a rate nobody chose, which is the bug.
    expect(MEMBER_MANAGEMENT).toMatch(/const \[commissionPct, setCommissionPct\] = useState\(''\)/);
    expect(MEMBER_MANAGEMENT).toMatch(/const \[rakebackPct, setRakebackPct\] = useState\(''\)/);
  });

  it('says out loud that co owners and admins earn none', () => {
    expect(MEMBER_MANAGEMENT).toMatch(/This Role Earns No Rakeback/);
    expect(MEMBER_MANAGEMENT).toMatch(/isClubStaff\(/);
  });
});

describe('the server refuses a promotion with no rate', () => {
  it('the migration exists and is the one that was applied', () => {
    expect(exists(MIGRATION_STAFF)).toBe(true);
  });

  it('fn_club_set_member_role takes the two rates', () => {
    const sql = read(MIGRATION_STAFF);
    expect(sql).toMatch(/p_commission_rate\s+numeric/);
    expect(sql).toMatch(/p_player_rakeback_rate\s+numeric/);
  });

  it('returns needs_rates rather than inventing a pair', () => {
    const sql = read(MIGRATION_STAFF);
    expect(sql).toMatch(/'needs_rates'/);
    // The invented defaults are gone. If either pair comes back, so has the bug.
    expect(sql).not.toMatch(/THEN 0\.50 ELSE 0\.30 END/);
    expect(sql).not.toMatch(/THEN 0\.30 ELSE 0\.20 END/);
  });

  it('applies the rate on the UPDATE branch too, not only the INSERT', () => {
    const sql = read(MIGRATION_STAFF);
    expect(sql).toMatch(/UPDATE agents[\s\S]{0,400}commission_rate\s*=\s*v_comm/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CO-OWNERS AND ADMINS EARN NO RAKEBACK
// ─────────────────────────────────────────────────────────────────────────────
describe('staff earn no rakeback, by construction', () => {
  it('a trigger zeroes the member rate columns', () => {
    const sql = read(MIGRATION_STAFF);
    expect(sql).toMatch(/trg_club_members_staff_earn_no_rakeback/);
    expect(sql).toMatch(/NEW\.player_rakeback_pct\s*:=\s*0/);
  });

  it('a trigger zeroes the agents rate columns', () => {
    const sql = read(MIGRATION_STAFF);
    expect(sql).toMatch(/trg_agents_staff_earn_no_rakeback/);
    expect(sql).toMatch(/NEW\.player_rakeback_rate\s*:=\s*0/);
  });

  it('leaves the agents ROW alone, because it is also the wallet', () => {
    // fn_ensure_agent_row mints that row for a club-bank send. Suspending or
    // deleting it to enforce a rate rule would strand chips in it.
    const sql = read(MIGRATION_STAFF);
    expect(sql).not.toMatch(/DELETE FROM agents/i);
  });

  it('refuses a rate offered alongside a staff role', () => {
    const sql = read(MIGRATION_STAFF);
    expect(sql).toMatch(/co owners and admins receive no rakeback/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ONE WRITE PATH
// ─────────────────────────────────────────────────────────────────────────────
describe('a role changes through fn_club_set_member_role or not at all', () => {
  it('MembershipService.updateRole calls the RPC', () => {
    expect(MEMBERSHIP_SERVICE).toMatch(/rpc\('fn_club_set_member_role'/);
  });

  it('nothing in the client updates club_members.role directly', () => {
    for (const [name, src] of [
      ['MembershipService', MEMBERSHIP_SERVICE],
      ['ClubDetailPage', CLUB_DETAIL],
      ['ClubMemberManagement', MEMBER_ADMIN],
      ['MemberManagementPage', MEMBER_MANAGEMENT],
    ] as const) {
      expect(codeOnly(src), name).not.toMatch(/\.update\(\{\s*role[:,\s}]/);
    }
  });

  it('ClubDetailPage demotes to a role the database actually has', () => {
    // It demoted to 'member', which is not in club_members_role_check, so every
    // demotion from that menu failed.
    expect(codeOnly(CLUB_DETAIL)).not.toMatch(/updateRole\([^)]*'member'/);
    expect(CLUB_DETAIL).toMatch(/updateRole\(clubId, memberUserId, 'player'\)/);
  });

  it('the agent panel is not offered a role whose rate it cannot collect', () => {
    expect(MEMBER_ADMIN).toMatch(/ASSIGNABLE_HERE/);
    expect(MEMBER_ADMIN).not.toMatch(/<option value="agent">/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CO_OWNER IS A ROLE THAT DOES SOMETHING
// ─────────────────────────────────────────────────────────────────────────────
describe('co_owner is readable everywhere it is grantable', () => {
  it('an owner can grant it', () => {
    expect(grantableRoles('owner', 'player')).toContain('co_owner');
  });

  it('and it counts as staff in the client mirror', () => {
    expect(isClubStaff('co_owner')).toBe(true);
    expect(isAgentRole('co_owner')).toBe(false);
  });

  it('the engine admits it', () => {
    // server/src/handlers/admin.ts held the only role gate in the whole engine,
    // and a co-owner could not pause, resume or kick.
    const gates = SERVER_ADMIN.match(/\['owner',[^\]]*\]/g) ?? [];
    expect(gates.length).toBeGreaterThan(0);
    for (const gate of gates) expect(gate).toContain("'co_owner'");
  });

  it('messaging does not silently demote them to a player', () => {
    expect(MESSAGING).toMatch(/case 'co_owner':/);
    expect(MESSAGING).toMatch(/case 'super_agent':/);
    expect(MESSAGING).toMatch(/case 'sub_agent':/);
  });

  /**
   * MOVED, NOT DROPPED (phase 3 of 7, 2026-08-31).
   *
   * This pin was written when the modal compared senderRole against the single
   * word 'owner', which sent a co-owner's club allocation down the
   * agent-to-player path and out of the wrong account. It required
   * isClubStaff(senderRole) instead.
   *
   * isClubStaff is owner, co_owner and admin - ONE ROLE SHORT of the four that
   * may spend the club bank. A SUPER AGENT was still routed as an agent. The
   * modal now routes on CLUB_BANK_ROLES, the single list walletRows keeps and
   * fn_can_use_club_bank enforces server-side, so all four are covered.
   *
   * The rule is unchanged and still pinned here: never the bare word, always
   * the shared role helper.
   */
  it('a club-bank send is routed by the role list, not by the word owner', () => {
    expect(codeOnly(CHIP_TRANSFER)).not.toMatch(/senderRole === 'owner'/);
    expect(codeOnly(CHIP_TRANSFER)).toMatch(
      /CLUB_BANK_ROLES\.includes\(normaliseRole\(senderRole\)\)/
    );
    // And the four-role list is imported, never re-typed by hand.
    expect(codeOnly(CHIP_TRANSFER)).toMatch(/from '\.\.\/wallet\/walletRows'/);
  });

  it('useClubMembership asks clubRoles instead of a vocabulary that does not exist', () => {
    expect(HOOKS).not.toMatch(/role === 'club_owner'/);
    expect(HOOKS).not.toMatch(/role === 'club_admin'/);
    expect(HOOKS).toMatch(/isClubStaff\(role\)/);
  });

  it('the database half exists', () => {
    expect(exists(MIGRATION_CO_OWNER)).toBe(true);
    const sql = read(MIGRATION_CO_OWNER);
    expect(sql).toMatch(/fn_club_is_staff/);
    // fn_role_rank scored co_owner at 0, below a player's 1.
    expect(sql).toMatch(/WHEN 'co_owner'\s+THEN 6/);
  });
});

describe('the seven roles are still seven', () => {
  it('nothing has been added or dropped without this file being read', () => {
    expect(CLUB_ROLES.length).toBe(7);
  });
});
