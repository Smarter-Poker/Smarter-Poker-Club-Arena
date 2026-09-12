/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND MONEY DOOR HAS A SWITCH, AND THE SWITCH DEFAULTS CLOSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_poker_diamond_reserve` moves real Diamonds out of a real wallet into
 * custody, and it has two branches. The cash_seat branch was always admitted
 * through `ca_arena_settings.cash_games_enabled`, checked inside the same
 * fail-closed lookup that finds the table. The tournament_entry branch checked
 * nothing: it found the tournament, priced the entry, and reserved.
 *
 * That was harmless only because nothing called it. No Diamond tournament
 * exists and custody holds no rows, so no money moved through an open door.
 * The danger was never the past; it was that the FIRST caller would be
 * admitted, with no switch anywhere to refuse it and no way for whoever wrote
 * that caller to notice nothing was guarding them.
 *
 * A door that is merely unused is not a door that is shut. This law is what
 * keeps the switch from quietly disappearing again, and - just as important -
 * what keeps a migration from shipping the switch already flipped on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '..', 'supabase', 'migrations');

const doorFile = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith('_the_tournament_door_has_a_switch.sql'))
  .sort()
  .at(-1);
if (!doorFile) throw new Error('the tournament door migration is missing');

/**
 * Comments carry no behaviour, and this migration's header discusses every
 * string the assertions below look for. Reading the prose as if it were the
 * rule is exactly the mistake that made three earlier anchors match their own
 * explanatory comments.
 */
const executable = readFileSync(join(MIGRATIONS, doorFile), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');

describe('LAW: the Diamond tournament door has a switch', () => {
  it('adds the switch, not null, defaulting to closed', () => {
    expect(executable).toMatch(
      /ADD COLUMN IF NOT EXISTS tournaments_enabled boolean NOT NULL DEFAULT false/i
    );
  });

  it('admits a tournament entry only when the switch is on', () => {
    expect(executable).toContain('a.tournaments_enabled');
    expect(executable).toContain('diamond_tournaments_not_open');
  });

  it('decides the arena, the union exclusions and the switch in one lookup', () => {
    // All of it in the row-finding WHERE, so a chip club, a union-owned
    // tournament, a missing settings row and a closed switch all arrive as
    // NOT FOUND rather than as four checks somebody can reorder or forget.
    expect(executable).toMatch(/c\.asset='diamonds'/);
    expect(executable).toMatch(/c\.is_platform IS TRUE/);
    expect(executable).toMatch(
      /c\.union_id IS NULL AND t\.union_id IS NULL AND a\.tournaments_enabled/
    );
  });

  it('keeps "not open" and "wrong price" as different answers', () => {
    // A caller that cannot tell a closed arena from a mispriced entry will
    // retry the one it cannot fix.
    expect(executable).toContain('invalid_diamond_entry_price');
    const notOpen = executable.indexOf('diamond_tournaments_not_open');
    const wrongPrice = executable.indexOf('invalid_diamond_entry_price');
    expect(notOpen).toBeGreaterThan(-1);
    expect(wrongPrice).toBeGreaterThan(-1);
    expect(notOpen).not.toBe(wrongPrice);
  });

  it('does not open the door it installs', () => {
    // The switch ships closed. A migration that adds a door and flips it on in
    // the same breath has not added a door.
    expect(executable).not.toMatch(/tournaments_enabled\s*=\s*true/i);
    expect(executable).not.toMatch(/SET\s+tournaments_enabled/i);
  });

  it('leaves the cash switch alone', () => {
    expect(executable).not.toMatch(/SET\s+cash_games_enabled/i);
    expect(executable).not.toMatch(/cash_games_enabled\s*=\s*(true|false)/i);
  });

  it('refuses to stand if a tournament custody row already existed', () => {
    // The migration asserts the estate it believed it was changing.
    expect(executable).toMatch(/poker_diamond_custody WHERE purpose='tournament_entry'/);
  });
});
