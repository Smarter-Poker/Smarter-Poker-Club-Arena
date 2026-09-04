/**
 * One club message, one length.
 *
 * Found 2026-09-03. The same column was governed by four rules nobody had
 * reconciled:
 *
 *   clubs_lobby_message_character_limit        CHECK <= 72
 *   fn_set_club_lobby_message                  left(v_clean, 240)
 *   fn_save_club_identity_messages_versioned   rejects > 72
 *   the three client editors                   72, 240 and 72
 *
 * `fn_set_club_lobby_message` therefore accepted up to 240 characters,
 * truncated to 240, and handed the row to a CHECK that allowed 72. Proved
 * against production in a rolled-back transaction: 72 saved, 100 and 240 both
 * raised `violates check constraint`. Not a named refusal the client could
 * explain - a raw constraint violation that reached the operator as "Could Not
 * Save The Club Message" with nothing to act on.
 *
 * The desktop editor offered a 240-character box, so any staff member who used
 * more than the first 72 characters hit it. It shipped on 2026-09-01 and stayed
 * invisible because the only clubs that ever saved were the ones who wrote
 * short.
 *
 * 72 was right for a one-line strip clipped in a fixed-height row. That strip
 * is gone; the message is a full-screen greeting. Everything is 240 now, and
 * these pins exist so the four numbers cannot drift apart again.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MIGRATION = read(
  'supabase/migrations/20260903203214_one_length_for_the_club_message_not_three.sql'
);
const SERVICE = read('src/services/ClubMessageManagementService.ts');
const GREETING = read('src/components/club/ClubEntryMessage.tsx');

describe('one length for the club message, not four', () => {
  it('moves the column CHECK to 240', () => {
    expect(MIGRATION).toContain('clubs_lobby_message_character_limit');
    expect(MIGRATION).toMatch(/char_length\(COALESCE\(lobby_message, ''::text\)\) <= 240/);
  });

  it('brings the versioned writer to the same 240', () => {
    expect(MIGRATION).toMatch(/char_length\(COALESCE\(p_lobby_message, ''\)\) > 240/);
  });

  /**
   * The tagline is NOT the message. It is the permanent identity line printed
   * under the club name, it is one line by design, and widening it was never
   * part of this. Pinned so a future alignment does not sweep it up.
   */
  it('leaves the tagline at 72', () => {
    expect(MIGRATION).toMatch(/char_length\(COALESCE\(p_tagline, ''\)\) > 72/);
    expect(SERVICE).toContain('tagline: 72');
  });

  it('brings both clients to 240', () => {
    expect(SERVICE).toContain('lobbyMessage: 240');
    expect(GREETING).toContain('CLUB_ENTRY_MESSAGE_MAX = 240');
  });

  /**
   * 17 of the 17 clubs with a message had no lobby_message_updated_at, because
   * only one of the two writers stamped it. A timestamp that half the writes
   * skip is worse than no timestamp: it reads as "never written" for a message
   * saved this morning.
   */
  it('stamps lobby_message_updated_at from the versioned writer too', () => {
    expect(MIGRATION).toContain('lobby_message_updated_at = CASE');
    expect(MIGRATION).toContain('IS DISTINCT FROM lobby_message THEN now()');
  });

  /** Clearing the message clears its timestamp rather than leaving a fossil. */
  it('clears the timestamp when the message is cleared', () => {
    expect(MIGRATION).toMatch(/WHEN NULLIF\(v_lobby, ''\) IS NULL THEN NULL/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONLY A MESSAGE SOMEONE WROTE EARNS THE SCREEN (2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "the pop up card STILL blocks the entire page when it loads".
 *
 * The dismissal was fine and the client was fine. fn_get_club_entry_message
 * carried the right intent in its own comment - "Only a message somebody
 * actually wrote earns the screen" - but only excluded the tagline COLUMN. It
 * could not tell a typed message from one seeded into lobby_message by a
 * migration, and on this platform every single one was seeded:
 *
 *     clubs with a lobby_message                       4
 *     ... never written by staff (updated_at IS NULL)  4   <- all of them
 *     ... where lobby_message is literally the tagline  2
 *
 * "West Coast Grinders", "THE BEST POKER UNION ON THE PLANET" - identity
 * lines, not announcements, full-screen, on every entry, forever, because the
 * X deliberately does not silence the club.
 *
 * The tests above already pin that lobby_message_updated_at is stamped on a
 * real save and cleared when the message is cleared. These pin that the READER
 * consults it, which is what turns that timestamp from a fact into a guard.
 */
describe('only a message someone actually wrote earns the screen', () => {
  const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'supabase/migrations');

  /** The newest migration defining the reader - the one Postgres ends up with. */
  const governingReader = (): string => {
    const all = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8').includes(
          'CREATE OR REPLACE FUNCTION public.fn_get_club_entry_message'
        )
      );
    expect(all.length, 'no migration defines fn_get_club_entry_message').toBeGreaterThan(0);
    return readFileSync(resolve(MIGRATIONS_DIR, all[all.length - 1]), 'utf8');
  };

  const shouldShowExpr = (sql: string): string => {
    const i = sql.indexOf("'should_show'");
    expect(i, 'the reader must still answer should_show').toBeGreaterThan(0);
    return sql.slice(i, sql.indexOf(');', i));
  };

  it('requires evidence a human wrote the message, not merely that one exists', () => {
    expect(
      /v_updated\s+IS\s+NOT\s+NULL/i.test(shouldShowExpr(governingReader())),
      'should_show does not check lobby_message_updated_at, so a message seeded by a ' +
        'migration interrupts every entry forever with text nobody typed.'
    ).toBe(true);
  });

  it('still refuses an empty or whitespace-only message', () => {
    expect(shouldShowExpr(governingReader())).toMatch(/btrim\(v_message\)\s*<>\s*''/);
  });

  it('still silences a message the person already dismissed', () => {
    // The revision comparison is what makes "do not show me this again" stick
    // until staff write something new.
    expect(shouldShowExpr(governingReader())).toMatch(
      /v_dismissed\s+IS\s+NULL\s+OR\s+v_dismissed\s*<\s*COALESCE\(v_revision,\s*0\)/i
    );
  });

  it('the check would have caught the shipped defect', () => {
    // Both directions: the pre-fix reader must NOT satisfy the new pin, or the
    // pin is asserting something that was never in question.
    const all = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8').includes(
          'CREATE OR REPLACE FUNCTION public.fn_get_club_entry_message'
        )
      );
    const withoutTheGuard = all
      .map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8'))
      .map(shouldShowExpr)
      .filter((e) => !/v_updated\s+IS\s+NOT\s+NULL/i.test(e));
    expect(
      withoutTheGuard.length,
      'every historical reader already had the guard, so this pin is not detecting anything ' +
        'and must be re-derived.'
    ).toBeGreaterThan(0);
  });
});
