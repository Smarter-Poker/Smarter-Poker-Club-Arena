/**
 * MADNESS WITHOUT LIGHTNING SAYS MADNESS (Dan 2026-10-24)
 *
 * "NO I DON'T WANT A LIGHTNING GAME, JUST A REGULAR PLO5 MADNESS GAME 50% VPIP
 * WITH BB ANTE" - then, seeing the board: "THERE IS NO PLO5 MADNESS GAME
 * RUNNING". The game was running; the board called it Classic because its
 * game row is a Classic must-move game (Lightning owns the Madness template).
 * The card now names the game from the rules its tables enforce.
 */
import { describe, expect, it } from 'vitest';
import {
  cashEntry,
  cashStyleNote,
  cashTitleLines,
  plainMadnessStyleOf,
  type LobbyTableRow,
} from '../../src/components/lobby/lobbyEntries';
import { arenaGameCardDataFromEntry } from '../../src/components/lobby/game-cards/arenaGameCardAdapter';

const row = (over: Partial<LobbyTableRow>): LobbyTableRow =>
  ({
    id: 't',
    name: 'PLO5 1/2 Madness',
    game_variant: 'plo5',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 200,
    max_buy_in: 400,
    current_players: 6,
    max_players: 6,
    status: 'running',
    cluster_id: 'g',
    cluster_template: 'classic',
    big_blind_ante_enabled: true,
    ante_enabled: true,
    ante: 2,
    nit_game: true,
    maintain_percent_min: 50,
    maintain_hands: 10,
    ...over,
  }) as LobbyTableRow;

describe('a Classic must-move game playing Madness rules', () => {
  it('is called Madness, with its own ante and floor beside it', () => {
    const e = cashEntry(row({}));
    expect(cashTitleLines(e).subtitle).toBe('Madness');
    expect(cashStyleNote(e)).toBe('Big Blind Ante, 50% Minimum VPIP');
  });

  it('reads the same on the phone and premium cards', () => {
    const data = arenaGameCardDataFromEntry(cashEntry(row({})));
    expect(data.styleNote).toBe('Big Blind Ante, 50% Minimum VPIP');
    expect(data.subtitle ?? '').not.toMatch(/classic/i);
  });

  it('stays an ordinary game: never Lightning', () => {
    const e = cashEntry(row({}));
    expect(e.game?.template).toBe('classic');
    expect(e.game?.lightning ?? null).toBeNull();
  });
});

describe('a plain Classic game is untouched', () => {
  it('no ante or no floor means Classic, with no note', () => {
    for (const over of [
      { big_blind_ante_enabled: false },
      { nit_game: false },
      { maintain_percent_min: 0 },
      { big_blind_ante_enabled: null, nit_game: null, maintain_percent_min: null },
    ] as Partial<LobbyTableRow>[]) {
      const e = cashEntry(row(over));
      expect(cashTitleLines(e).subtitle).toBe('Classic');
      expect(cashStyleNote(e)).toBeNull();
    }
  });

  it('only Classic is restyled; Lightning Games keep their own label and note', () => {
    expect(plainMadnessStyleOf(row({ cluster_template: 'madness' }))).toBeNull();
    const e = cashEntry(row({ cluster_template: 'madness', maintain_percent_min: 40 }));
    expect(cashTitleLines(e).subtitle).toBe('Lightning Games');
    expect(cashStyleNote(e)).toBe('Big Blind Ante, 40% Minimum VPIP');
  });
});

describe('Madness is its own style on the board', () => {
  it('counts and filters apart from Classic and Lightning Games', async () => {
    const { countStylesOnBoard, cashStyleKeyOf } =
      await import('../../src/components/lobby/lobbyEntries');
    const { CASH_STYLES } = await import('../../src/components/lobby/advancedFilterSpec');
    expect(CASH_STYLES.find((s) => s.key === 'straight_madness')?.label).toBe('Madness');
    expect(cashStyleKeyOf(row({}))).toBe('straight_madness');
    expect(cashStyleKeyOf(row({ nit_game: false }))).toBe('classic');
    expect(cashStyleKeyOf(row({ cluster_template: 'action' }))).toBe('madness');
    const front = { role: 'main', main_index: 1 } as Partial<LobbyTableRow>;
    expect(
      countStylesOnBoard([
        row({ ...front, cluster_id: 'a' }),
        row({ ...front, cluster_id: 'b', nit_game: false }),
        row({ ...front, cluster_id: 'c', cluster_template: 'madness' }),
      ])
    ).toEqual({ straight_madness: 1, classic: 1, madness: 1 });
  });
});
