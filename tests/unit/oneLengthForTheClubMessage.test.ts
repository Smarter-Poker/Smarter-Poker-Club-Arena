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
import { readFileSync } from 'node:fs';
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
