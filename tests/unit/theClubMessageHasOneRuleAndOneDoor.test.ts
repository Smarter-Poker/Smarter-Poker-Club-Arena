/**
 * The club message has one rule and one door.
 *
 * Dan, 2026-09-04: "THE CLUB MESSAGE DOESN'T POP UP AT ALL NOW... GET DONE TO
 * THE ROOT CAUSE OF WHAT WAS BROKEN AND FIX IT AT ITS CORE. THEN FIX IT SO IT
 * ACTUALLY WORKS, NEVER BLOCKS ENTIRE PAGES, AND CAN BE MANAGED FROM THE TABLE
 * MANEGEMENT PAGE BY CLUB OR UNION OWNERS."
 *
 * What was broken: 20260904012413 made the popup depend on
 * clubs.lobby_message_updated_at, a column that only SOME of the writers into
 * clubs.lobby_message maintained. Every club's message had been seeded without
 * it, so should_show was false for everyone and the popup vanished - 395
 * successful RPC calls, zero errors, nothing on screen.
 *
 * The laws below pin the shape of the fix rather than the symptom:
 *
 *   ONE RULE   a message that exists is shown until this person retires this
 *              revision of it. Which door the text came through is not the
 *              player's concern.
 *   ONE DOOR   every writer - and the management reader - authorises through
 *              fn_can_manage_club_message: club owner, club staff, or the union
 *              that oversees the club. The row stamps and versions itself in a
 *              trigger, so a writer cannot forget to.
 *   NOT A WALL the greeting closes when you tap beside it, and the Table
 *              Management page opens its Club Messages section to whoever the
 *              server admits, even on a club whose games belong to its union.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const MIGRATION_SUFFIX = '_the_club_message_has_one_rule_and_one_door.sql';
const migrationFile = readdirSync(resolve(root, 'supabase/migrations'))
  .filter((name) => name.endsWith(MIGRATION_SUFFIX))
  .sort()
  .pop();

/** The body of one CREATE OR REPLACE FUNCTION, from its AS $$ to its $$;. */
function functionBody(sql: string, name: string): string {
  const head = sql.indexOf(`FUNCTION public.${name}(`);
  expect(head, `${name} must be defined in the migration`).toBeGreaterThan(-1);
  const open = sql.indexOf('AS $$', head);
  const close = sql.indexOf('\n$$;', open);
  expect(open, `${name} must have a body`).toBeGreaterThan(head);
  expect(close, `${name} body must be terminated`).toBeGreaterThan(open);
  return sql.slice(open, close);
}

describe('the club message has one rule and one door', () => {
  it('ships as a migration', () => {
    expect(migrationFile, `expected supabase/migrations/*${MIGRATION_SUFFIX}`).toBeDefined();
  });

  const sql = () => read(`supabase/migrations/${migrationFile}`);

  /**
   * The predicate is Dan's sentence - club or union owners - written once.
   * Both club_members status spellings are live ('active' and 'approved');
   * fn_is_club_admin_uid only knew one, which is why staff could not write.
   */
  it('names one predicate for who may write the message', () => {
    const s = sql();
    expect(s).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_can_manage_club_message(p_club_id uuid, p_user_id uuid)'
    );
    const predicate = functionBody(s, 'fn_can_manage_club_message');
    expect(predicate).toContain('c.owner_id = p_user_id');
    expect(predicate).toContain("m.role IN ('owner', 'co_owner', 'admin', 'manager')");
    expect(predicate).toContain("IN ('active', 'approved')");
    expect(predicate).toContain('public.fn_union_oversees_club(p_club_id, p_user_id)');
    // And the browser can ask the same question about itself.
    expect(s).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_can_manage_club_message_uid(p_club_id uuid)'
    );
  });

  /**
   * Every door checks that predicate and nothing else. fn_can_create_games
   * rejected a member club's own owner; fn_is_club_admin_uid rejected every
   * staff row whose status read 'approved'. Neither is a message rule.
   */
  it('every writer and the management reader use that predicate', () => {
    const s = sql();
    for (const fn of [
      'fn_set_club_lobby_message',
      'fn_get_club_message_management',
      'fn_save_club_identity_messages_versioned',
    ]) {
      const body = functionBody(s, fn);
      expect(body, `${fn} must authorise through the one predicate`).toContain(
        'public.fn_can_manage_club_message(p_club_id, v_uid)'
      );
      expect(body, `${fn} must not fall back to the games rule`).not.toContain(
        'fn_can_create_games'
      );
      expect(body, `${fn} must not fall back to the staff-only rule`).not.toContain(
        'fn_is_club_admin_uid'
      );
    }
  });

  /**
   * The row keeps its own books. A writer that bumps the revision itself is
   * left alone (no double bump, so the versioned writer's compare-and-swap
   * still agrees with the client); one that forgets is corrected.
   */
  it('stamps and versions the message in the row, not in the writers', () => {
    const s = sql();
    expect(s).toContain('CREATE TRIGGER trg_clubs_lobby_message_keeps_its_own_books');
    expect(s).toMatch(/BEFORE INSERT OR UPDATE ON public\.clubs\s+FOR EACH ROW/);
    const trigger = functionBody(s, 'fn_clubs_lobby_message_keeps_its_own_books');
    expect(trigger).toContain('NEW.lobby_message IS DISTINCT FROM OLD.lobby_message');
    expect(trigger).toContain('NEW.message_revision IS NOT DISTINCT FROM OLD.message_revision');
    expect(trigger).toContain('NEW.message_revision := COALESCE(OLD.message_revision, 0) + 1');
    // Whitespace is not a message, at the row.
    expect(trigger).toContain("btrim(NEW.lobby_message) = ''");
  });

  /**
   * A message that exists earns the screen. The updated_at gate that silenced
   * every club is gone from the reader, and the messages that predate the
   * column are stamped so nothing downstream is left guessing.
   */
  it('shows a message that exists until this person retires this revision', () => {
    const s = sql();
    const reader = functionBody(s, 'fn_get_club_entry_message');
    expect(reader, 'the door the text came through is not a display rule').not.toMatch(
      /v_updated IS NOT NULL/
    );
    expect(reader).toContain("'should_show', v_message IS NOT NULL");
    expect(reader).toContain('v_dismissed IS NULL OR v_dismissed < COALESCE(v_revision, 0)');
    // The server states authority so the lobby can offer the editor to a union
    // owner the client cannot recognise on its own.
    expect(reader).toContain("'can_manage', public.fn_can_manage_club_message(p_club_id, v_uid)");
    expect(s).toMatch(
      /UPDATE public\.clubs\s+SET lobby_message_updated_at = now\(\)\s+WHERE lobby_message IS NOT NULL/
    );
  });
});

describe('the greeting is a card, never a wall', () => {
  const component = () => read('src/components/club/ClubEntryMessage.tsx');

  /** Tapping beside a small card closes it. A backdrop that eats taps is a wall. */
  it('closes when you tap beside it', () => {
    const src = component();
    expect(src).not.toContain('closeOnOverlay={false}');
    expect(src).toMatch(/closeOnOverlay(\s|$|\n)/);
  });

  /** The client trusts the server about who may edit, not just its own role read. */
  it('offers the editor to whoever the server says may manage the message', () => {
    const src = component();
    expect(src).toContain('can_manage');
    expect(src).toContain('canManage');
  });
});

describe('the Table Management page opens the message to club and union owners', () => {
  const page = () => read('src/pages/GameManagementPage.tsx');

  /**
   * Games on a member club are the union's to run and stay locked. The club
   * MESSAGE is not a game: the page asks the server its own question for it.
   */
  it('asks the server whether this person may manage the message', () => {
    const src = page();
    expect(src).toContain(
      "supabase.rpc('fn_can_manage_club_message_uid', { p_club_id: resolvedScopeId })"
    );
    expect(src).toContain('setMessagesAllowed(');
  });

  it('locks the whole page only when neither the games nor the message are this person’s', () => {
    const src = page();
    expect(src).toContain('allowed === false && !messagesAllowed');
    expect(src).toContain("surface === 'messages' && messagesAllowed && hostClubId");
  });

  /** A locked game board is a disabled section, not a closed page. */
  it('keeps the game sections locked on a member club while the message stays open', () => {
    const src = page();
    expect(src).toContain("disabled={allowed === false && key !== 'messages'}");
    expect(src).toContain("if (allowed === false && nextSurface !== 'messages') return;");
  });

  /** Still no host switching (Dan 2026-09-04). You open the club, you write the club. */
  it('does not add a club picker to get there', () => {
    const src = page();
    expect(src).not.toContain('<select value={hostClubId}');
    expect(src).not.toContain('changeHostClub');
  });
});
