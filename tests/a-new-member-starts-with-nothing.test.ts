/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A NEW MEMBER STARTS WITH ZERO CHIPS, AND LANDS IN THE RIGHT DOWNLINE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-26, binding, verbatim:
 *
 *   "NEW PLAYERS SHOULD 100% OF THE TIME ALWAYS START WITH ZERO CHIPS! THEY
 *    SHOULD NEVER EVER EVER HAVE CHIPS INSIDE THERE ACCOUNT WHEN THEY JOIN."
 *
 *   "MAKE SURE THIS PLAYER IS ATTACHED TO THE AGENT WHO REFERRED THEM AND IS
 *    ATTACHED TO THEIR DOWNLINES."
 *
 *   "IF THIS PLAYER (WHO DOESN'T HAVE AGENT STATUS) USES THERE SHARE CLUB JAQK
 *    LINK, ANY NEW PLAYER THAT JOINS SHOULD BE ATTACHED TO THE SAME UPLINE
 *    AGENT THAT THE PLAYER ACCOUNT IS."
 *
 * ── THE 1,000-CHIP MINT ──────────────────────────────────────────────────────
 *
 * `club_members.chip_balance` carried `DEFAULT 1000`. Dan's own test join
 * landed holding exactly that:
 *
 *   runbabyrun / runthetable45@gmail.com -> SHARK CLUB, chip_balance 1000.00
 *
 * `fn_club_chip_circulation()` counts that column as one of the two live chip
 * pools, and `reconcile_ledger_nightly` compares ledger movement against stored
 * balances, so a default-minted balance is drift nothing can ever explain.
 *
 * Three layers now, because a column default is one ALTER from returning: the
 * default is 0, `fn_join_club` names `chip_balance = 0` explicitly, and a
 * BEFORE INSERT trigger zeroes the money columns whatever the caller passed.
 * Horses are exempt on `profiles.is_horse` / `club_members.is_bot` — the fleet
 * is stocked, not bought, and a horse with no bankroll cannot sit down.
 *
 * Proved against production inside a transaction that rolled itself back:
 * an insert ASKING for 999,999 chips and 5,000 promo produced 0.00 and 0.00;
 * a horse insert asking for 50,000 kept 50,000.
 *
 * ── THE DOWNLINE ─────────────────────────────────────────────────────────────
 *
 * The invite-link half already worked once the redemption RPC was repaired —
 * verified live: runbabyrun is attached to kingfish, whose agents row reads
 * total_players 11 against a real downline of 11.
 *
 * The roll-up rule was proved on Club JAQK in the same rolled-back style:
 * betsizematters is a PLAIN PLAYER (not an agent) whose own upline is
 * "joseph hernandez". A new account joining on betsizematters' link came out
 * status=active, chip_balance=0.00, agent_id=joseph hernandez,
 * invited_by=betsizematters, and that agent's total_players went 11 -> 12,
 * matching a real downline row count of 12.
 *
 * The AGENT-UI half had never worked at all. `PlayerInviteModal` added a player
 * with `insert({ ..., referrer_id: agentId })` and club_members HAS NO
 * referrer_id column, so PostgREST rejected the statement every time. It also
 * never wrote `agent_id` — the column the hierarchy is built from — and it was
 * handed `agent.id` (the agents-table primary key) where a user id belonged.
 * `fn_agent_attach_player` replaces it; probed live, rolled back: the agent
 * claiming a player got chip_balance 0.00 and agent_id set, and a stranger
 * trying to stuff somebody into that agent's downline got 'not_authorized'.
 *
 * CI has no database, so the SQL assertions below are on the migration text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const MIGRATION = read('supabase/migrations/20260826_a_new_member_starts_with_nothing.sql');
const MODAL = read('src/components/agent/PlayerInviteModal.tsx');
const AGENT_SERVICE = read('src/services/AgentService.ts');
const AGENT_PAGE = read('src/pages/AgentManagementPage.tsx');

const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('--');
    })
    .join('\n');

describe('zero chips on join, at every layer', () => {
  it('the column default is 0, not 1000', () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE public\.club_members ALTER COLUMN chip_balance SET DEFAULT 0;/
    );
  });

  it('fn_join_club names the zero itself instead of trusting the default', () => {
    // A default is one ALTER away from coming back. The RPC that every join
    // goes through should be correct on its own.
    expect(MIGRATION).toMatch(/orange_ball_status, chip_balance\)/);
    expect(MIGRATION).toMatch(/'bronze', 0, 'cold', 0\)/);
  });

  it('a BEFORE INSERT guard overrides whatever the caller asked for', () => {
    expect(MIGRATION).toMatch(/CREATE TRIGGER trg_membership_starts_with_zero_chips/);
    expect(MIGRATION).toMatch(/BEFORE INSERT ON public\.club_members/);
    for (const col of [
      'chip_balance',
      'held_chips',
      'locked_chips',
      'promo_balance',
      'credit_used',
    ]) {
      expect(MIGRATION).toMatch(new RegExp(`NEW\\.${col}\\s+:=\\s+0;`));
    }
  });

  it('exempts horses, and only horses', () => {
    // HorseOnboarding seats a horse with 50,000 because the fleet is stocked
    // rather than bought. No human account can set is_horse or is_bot.
    expect(MIGRATION).toMatch(/COALESCE\(NEW\.is_bot, false\)/);
    expect(MIGRATION).toMatch(/COALESCE\(p\.is_horse, false\)/);
  });

  it('asserts the default actually landed instead of trusting the apply', () => {
    expect(MIGRATION).toMatch(/club_members\.chip_balance default is %, expected 0/);
  });
});

describe('the agent Add Player button', () => {
  it('no longer writes a column that does not exist', () => {
    // club_members has no referrer_id. PostgREST rejected the whole insert
    // (PGRST204), so this button had never once succeeded.
    expect(codeOnly(MODAL)).not.toMatch(/referrer_id/);
  });

  it('goes through the permission-checked RPC instead of a raw insert', () => {
    expect(MODAL).toMatch(/AgentService\.attachPlayerToAgent\(clubId, agentUserId, player\.id\)/);
    expect(AGENT_SERVICE).toMatch(/rpc\('fn_agent_attach_player'/);
  });

  it('is handed the agent USER id, not the agents-table primary key', () => {
    expect(AGENT_PAGE).toMatch(/setPlayerInviteAgentUserId\(agent\.userId\)/);
    expect(AGENT_PAGE).toMatch(/agentUserId=\{playerInviteAgentUserId \|\| ''\}/);
  });

  it('lets an agent claim only an unattached player, while staff may move one', () => {
    expect(MIGRATION).toMatch(/already_in_a_downline/);
    expect(MIGRATION).toMatch(/You can only add players to your own downline/);
  });

  it('re-derives the downline counts rather than incrementing them', () => {
    // A counter that is added to drifts; a counter that is recomputed cannot.
    expect(MIGRATION).toMatch(/total_players = \(SELECT count\(\*\) FROM club_members/);
    expect(MIGRATION).toMatch(/active_player_count = \(SELECT count\(\*\) FROM club_members/);
  });
});

describe('the shareable invite link an agent hands out', () => {
  it('is a link that redeems, not a code nothing reads', () => {
    // club_invites holds zero rows and NOTHING in the codebase reads it, so the
    // generated code could never be redeemed by any path.
    expect(codeOnly(MODAL)).not.toMatch(/club_invites/);
    expect(MODAL).toMatch(/\/hub\/club-arena\/invite\/\$\{resolvedClubId\}\?ref=\$\{ref\}/);
  });

  it('carries the agent player_number the redemption RPC matches on', () => {
    expect(MODAL).toMatch(/select\('player_number'\)/);
    expect(MODAL).toMatch(/profile\?\.player_number \|\| agentUserId/);
  });
});
