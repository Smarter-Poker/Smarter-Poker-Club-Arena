/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE OLD TABLES ARE GONE, AND THE COUNTER IS DERIVED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-26: "ANYTHING THATS POINT TO AN [OLD] TABLE OR PAGE, CAN AND
 * SHOULD BE DELETED."
 *
 * WHAT WENT
 *
 *   - Eight foreign keys checked `public.users`, a legacy shadow identity
 *     table that signup stopped writing long ago. Six repointed to `profiles`
 *     (verified row by row first: 3 club owners, 0 breakages, the other five
 *     child tables empty). The seventh belonged to `player_wallets`, whose six
 *     rows are PlayerOne..PlayerSix seed accounts from January that exist in
 *     neither profiles nor auth.users and which NOTHING in src/ or server/src
 *     reads - so the table went instead of the constraint.
 *   - `club_invites`: zero rows, one writer (already replaced with a redeemable
 *     link), and no readers at all. Every code it ever generated was inert.
 *
 * WHAT DELIBERATELY STAYED, and this is the part worth reading
 *
 *   - `public.users` itself. Three client files still WRITE it and 1,037 of its
 *     2,059 rows are absent from profiles. Nothing REFERENCES it any more,
 *     which is the precondition for removing it, but taking it out in the same
 *     breath as the constraints would have taken a live signup path with it.
 *   - `public.wallets`. CLAUDE.md says "Nothing reads it." That is WRONG:
 *     PlayerSearch, ChipTransferModal, SettingsPage, TablePage and
 *     ChipFlowService all read it, it holds 1,852 rows, and chip_escrow_holds
 *     has a RESTRICT foreign key into it. Dropping it would have broken five
 *     screens on the strength of a stale comment.
 *
 * THE COUNTER
 *
 * ClubsService claimed twice that `clubs.member_count` was "auto-synced by the
 * trg_sync_club_member_count trigger". That trigger did not exist and never
 * had. One hand-rolled increment on InvitePage was the only writer, and nothing
 * decremented, so every club drifted upward: SHARK 591 against 590 real rows,
 * JAQK 585 against 584. It is derived from the rows now.
 *
 * These are source-text guards; the database facts behind each were verified
 * against production before the migrations were applied, and re-checked after.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const DROP = read('supabase/migrations/20260826_stop_pointing_at_the_legacy_users_table.sql');
const COUNT = read('supabase/migrations/20260826_member_count_is_derived_not_hand_wound.sql');
const PLAYER_SEARCH = read('src/components/admin/PlayerSearch.tsx');

const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('--') && !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');

describe('nothing references the legacy users table any more', () => {
  it('repoints all six survivable foreign keys at profiles', () => {
    for (const t of [
      'clubs',
      'commission_rate_audit',
      'hand_actions',
      'rake_attributions',
      'rake_rate_audit',
      'tournament_waitlists',
    ]) {
      expect(DROP).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\b`));
    }
    expect((DROP.match(/REFERENCES public\.profiles\(id\)/g) || []).length).toBe(6);
  });

  it('drops the two dead tables', () => {
    expect(DROP).toMatch(/DROP TABLE IF EXISTS public\.player_wallets;/);
    expect(DROP).toMatch(/DROP TABLE IF EXISTS public\.club_invites;/);
  });

  it('refuses to drop player_wallets if a real account ever appears in it', () => {
    expect(DROP).toMatch(/player_wallets now holds a row for a real auth user - do not drop it/);
  });

  it('refuses to drop club_invites if something started using it', () => {
    expect(DROP).toMatch(/club_invites is no longer empty/);
  });

  it('proves afterwards that nothing points at public.users', () => {
    expect(DROP).toMatch(/still % foreign keys pointing at public\.users/);
  });

  it('does not touch public.wallets, which five modules still read', () => {
    expect(codeOnly(DROP)).not.toMatch(/DROP TABLE.*\bwallets\b/);
  });

  it('does not drop public.users while three client files still write it', () => {
    expect(codeOnly(DROP)).not.toMatch(/DROP TABLE IF EXISTS public\.users/);
  });
});

describe('clubs.member_count', () => {
  it('finally has the trigger the comments promised', () => {
    expect(COUNT).toMatch(/CREATE TRIGGER trg_sync_club_member_count/);
    expect(COUNT).toMatch(/AFTER INSERT OR DELETE OR UPDATE OF status, club_id/);
  });

  it('recomputes rather than increments', () => {
    // An incremented counter drifts. This one cannot.
    expect(COUNT).toMatch(/SET member_count = \(\s*SELECT count\(\*\) FROM club_members/);
    expect(codeOnly(COUNT)).not.toMatch(/member_count = member_count \+/);
  });

  it('counts settled memberships only, not pending requests', () => {
    expect(COUNT).toMatch(/status IN \('active', 'approved'\)/);
  });

  it('recounts the club a member moved AWAY from as well', () => {
    expect(COUNT).toMatch(/OLD\.club_id IS DISTINCT FROM NEW\.club_id/);
  });

  it('backfills the existing drift and then proves there is none', () => {
    expect(COUNT).toMatch(/UPDATE clubs c/);
    expect(COUNT).toMatch(/still have a member_count that disagrees with their rows/);
  });

  it('makes the club_id default the same five digits the client generates', () => {
    expect(COUNT).toMatch(/SET DEFAULT \(10000 \+ floor\(random\(\) \* 90000\)\)::integer/);
  });
});

describe('the admin player search', () => {
  it('is scoped to the club it was opened from', () => {
    // The prop was declared and never used, so one club's Players tab searched
    // every profile on the platform - email included.
    expect(PLAYER_SEARCH).toMatch(/club_members!inner\(club_id\)/);
    expect(PLAYER_SEARCH).toMatch(/\.eq\('club_members\.club_id', clubId\)/);
  });

  it('says so rather than quietly searching everybody when no club is given', () => {
    expect(PLAYER_SEARCH).toMatch(/No Club Selected\. Open This From A Club\./);
  });

  it('reads the balance from the pool that actually holds chips', () => {
    // It read `wallets` filtered to wallet_type PLAYER. That table's only
    // SELECT policy is `auth.uid() = user_id`, so an admin got back their own
    // row and every player showed 0. club_members.chip_balance is the live
    // pool and was already being queried on the next line.
    expect(codeOnly(PLAYER_SEARCH)).not.toMatch(/from\('wallets'\)/);
    expect(PLAYER_SEARCH).toMatch(/chip_balance/);
  });
});
