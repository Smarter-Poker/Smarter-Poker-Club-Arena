/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NINETEEN CONTROLS THAT DID NOTHING, AND THE ONE THAT MUST STAY OFF
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every entry in the phantom-write backlog was a write naming a column that does
 * not exist. Postgres rejects the whole statement, the error lands in a catch,
 * and the control it belonged to silently does nothing: Pin and Unpin did not
 * pin, a login streak was computed and never saved, the agent audit trail
 * recorded no assignment, referral bonuses were paid and never recorded, and a
 * player leaving a table was never written to its history.
 *
 * Two of the nineteen were not merely dead, and both are pinned hardest here:
 *
 *   profiles.status_text - the WRITER was rejected while the two READERS
 *     aliased `status_text:status`, so a profile rendered its ACCOUNT STATE,
 *     "active", where the player's own words belong.
 *
 *   tournament_players.buy_in_amount - the rejection was the only thing keeping
 *     a browser-side raw INSERT switched off. Naming the column correctly would
 *     have re-opened, in the client, the buy-in bypass closed on the engine on
 *     2026-08-19: no wallet debit, no rake row, no prize-pool contribution,
 *     while pools still paid in full. Roughly 27,000 to 30,000 chips a day.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceStatement } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

/**
 * Comments carry no behaviour, and every fix below is EXPLAINED in a comment
 * that necessarily quotes the wrong column name it replaced. Asserting on raw
 * source would therefore match the documentation and fail, and the obvious way
 * out of that is to delete the explanation - which is the wrong direction.
 * Strip comments first, exactly as every source-grep gate in this repo does.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** The object literal passed to one `.insert(` or `.update(` call. */
const writeTo = (src: string, table: string): string => {
  const at = code(src).indexOf(`from('${table}')`);
  if (at < 0) throw new Error(`no write to ${table}`);
  return sliceStatement(code(src), `from('${table}')`);
};

describe('the backlog is empty and may only ever shrink', () => {
  const allow = JSON.parse(read('scripts/ci/supabase-invariants.allowlist.json'));

  it('has no phantom columns left to forgive', () => {
    /**
     * The list grew by five between 2026-08-27 and 2026-08-28 while carrying a
     * comment saying it must only shrink, because a comment enforces nothing.
     * At zero, any new entry has to be added deliberately and fails here.
     */
    const tables = Object.keys(allow.phantomColumns).filter((k) => !k.startsWith('_'));
    expect(tables).toEqual([]);
  });
});

describe('every dead write now names a column that exists', () => {
  it('Pin writes is_pinned, not the SELECT alias', () => {
    const src = read('src/pages/AdminDashboardPage.tsx');
    expect(src).toContain('.update({ is_pinned: !item.pinned })');
    expect(src).not.toContain('.update({ pinned:');
  });

  it('a login streak is saved to the columns the mapper reads', () => {
    const src = read('src/services/ProfileService.ts');
    expect(src).toContain('login_streak: currentStreak');
    expect(src).toContain('streak_days: longestStreak');
    expect(src).not.toMatch(/current_streak:\s*currentStreak/);
    expect(src).not.toMatch(/longest_streak:\s*longestStreak/);
  });

  it('a hand is saved with pot, which is what the hands table calls it', () => {
    const src = read('src/services/HandHistoryService.ts');
    expect(src).toContain('pot: handData.pot');
    expect(src).not.toContain('pot_size: handData.pot');
  });

  it('leaving a table is recorded with action and metadata', () => {
    const src = read('src/services/TableService.ts');
    expect(src).toContain("action: 'leave'");
    expect(src).toContain('chips_cashed_out: chipsToReturn');
    expect(src).not.toMatch(/activity_type:\s*'leave'/);
  });

  it('the agent audit trail supplies the NOT NULL columns as well as the right ones', () => {
    // actor_role and target_type are NOT NULL with no default, so repointing
    // the three phantom names alone would have left the insert still failing.
    const src = read('src/services/AgentService.ts');
    expect(src).toContain('actor_id: assignedBy');
    expect(src).toContain("actor_role: 'club_admin'");
    expect(src).toContain("target_type: 'user'");
    expect(src).toContain('target_id: playerId');
    expect(src).not.toContain('performed_by:');
    expect(src).not.toContain('target_user_id:');
  });

  it('a referral is recorded with referee_id and its NOT NULL code', () => {
    const src = read('src/services/PromotionService.ts');
    const insert = writeTo(src, 'referrals');
    expect(insert).toContain('referee_id: referredUserId');
    expect(insert).toContain('referral_code_used: referrerCode');
    expect(insert).not.toContain('referred_id:');
    // promotion_id and bonus_amount are not columns on `referrals` at all. The
    // amount is not lost: WalletService.logTransaction wrote it just above.
    // Scoped to this insert on purpose - promotion_claims really does carry a
    // bonus_amount, and a file-wide grep would forbid the correct write too.
    expect(insert).not.toContain('bonus_amount:');
    expect(insert).not.toContain('promotion_id:');
  });

  it('the tutorial reset no longer writes a column nothing reads', () => {
    const src = read('src/components/navigation/HamburgerMenu.tsx');
    expect(src).not.toContain('tutorial_completed: false');
    // localStorage is, and always was, the only thing the intro gate consults.
    expect(src).toContain('STORAGE_KEYS.TUTORIAL_COMPLETED');
  });
});

describe('a profile shows the player, not the account state', () => {
  const src = read('src/services/PlayerStatusService.ts');

  it('reads the real status_text column instead of aliasing status', () => {
    expect(code(src)).not.toContain('status_text:status');
    expect(code(src)).toContain("select('id, status_text, is_online, last_seen')");
  });

  it('and the column it writes to now exists', () => {
    const mig = read('supabase/migrations/20260828034000_profiles_status_text.sql');
    expect(mig).toContain('ADD COLUMN IF NOT EXISTS status_text text');
  });
});

describe('the horse buy-in bypass stays switched off', () => {
  const src = read('src/services/HorseOrchestrator.ts');

  it('no longer inserts horses straight into tournament_players', () => {
    /**
     * This is the one entry where fixing the column name would have made
     * things WORSE. The rejected write was the only thing keeping the bypass
     * off. Registration belongs to the engine, through
     * fn_register_horse_for_tournament, which performs the same entry split,
     * debit, rake row and pool updates as the human path.
     */
    expect(code(src)).not.toContain('buy_in_amount: 0');
    // `tournaments.buy_in_amount` is a real column this file legitimately
    // writes when it CREATES an event, so the ban is on the zero-buy-in
    // registration shape, not on the name.
    expect(code(src)).not.toMatch(/from\('tournament_players'\)\s*\.insert\(/);
  });

  it('says why, so nobody re-adds it as a convenience', () => {
    expect(src).toContain('fn_register_horse_for_tournament');
    expect(src).toContain('27,000');
  });
});
