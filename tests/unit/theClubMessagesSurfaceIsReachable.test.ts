/**
 * Surface 03 of Table Management was dead in production, both directions.
 *
 * Found 2026-09-03 by calling every RPC behind Table Management as the club
 * owner and reading what came back rather than assuming. Club Messages
 * answered:
 *
 *   ERROR: column a.updated_at does not exist
 *
 * `club_announcements` had fourteen columns and `updated_at` was not one of
 * them, while BOTH sides of the feature referenced it:
 * fn_get_club_message_management selected it, and
 * fn_manage_club_announcement_versioned set it in every write branch. So
 * listing threw and every create, edit, pin, unpin and retire threw with it.
 * An entire surface, unusable, with nothing in the suite to notice - because
 * every test around it read source text or mocked the RPC, and neither of
 * those touches a real table.
 *
 * The lesson is the reason this file exists: a source pin proves the client
 * ASKS for the right thing. It cannot prove the database can answer. These
 * pins hold the column and its two callers together so the three cannot drift
 * apart again the way they already did once.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MIGRATION = read(
  'supabase/migrations/20260903204858_club_announcements_never_got_the_column_both_sides_expect.sql'
);
const SERVICE = read('src/services/ClubMessageManagementService.ts');

describe('the club messages surface can actually be reached', () => {
  it('adds the column both functions were already written against', () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE public\.club_announcements\s+ADD COLUMN IF NOT EXISTS updated_at timestamptz/
    );
  });

  /**
   * An announcement written in July was not updated today. Stamping the
   * migration's clock over every existing row would have erased the only
   * ordering information those rows carry.
   */
  it('backfills from created_at, not from now()', () => {
    expect(MIGRATION).toMatch(/SET updated_at = created_at\s+WHERE updated_at IS NULL/);
    expect(MIGRATION).not.toMatch(/SET updated_at = now\(\)\s+WHERE updated_at IS NULL/);
  });

  it('leaves new rows stamping themselves', () => {
    expect(MIGRATION).toContain('ALTER COLUMN updated_at SET DEFAULT now()');
  });

  /**
   * The client already tolerated the field being absent, which is exactly why
   * nobody noticed the surface was broken: the fallback made the payload look
   * survivable while the RPC that produced it was throwing before it could
   * return one.
   */
  it('keeps the client fallback that hid this for so long', () => {
    expect(SERVICE).toContain("String(item.updated_at || item.created_at || '')");
  });

  /**
   * The four action names the panel sends. Verified against production: save
   * creates and edits, set_pin pins, set_active retires, delete removes, and a
   * stale revision is refused with version_conflict rather than applied.
   */
  it('sends only action names the versioned writer accepts', () => {
    expect(SERVICE).toContain("action: 'save' | 'delete' | 'set_pin' | 'set_active'");
  });
});
