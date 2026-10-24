import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import LobbyTable from '../../src/components/lobby/LobbyTable';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { arenaGameCardDataFromEntry } from '../../src/components/lobby/game-cards/arenaGameCardAdapter';
import { SpadePloCard } from '../../src/components/lobby/game-cards/SpadePloCard';
import { PloFourBayCard } from '../../src/components/lobby/game-cards/PloFourBayCard';
import { NlhPremiumCard } from '../../src/components/lobby/game-cards/NlhPremiumCard';
import type {
  ArenaGameCardActions,
  ArenaGameCardData,
} from '../../src/components/lobby/game-cards/arenaGameCardTypes';
import { CASH_TEMPLATES, cashTemplateNote } from '../../src/config/cashGames';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ACTION AND MADNESS SAY WHAT THEY CHANGE (Dan 2026-10-15)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "WHEN CASH GAMES ARE DISPLAYED WITH 'CLASSIC' 'ACTION' AND
 * 'MADNESS' THERE SHOULD BE A DESCRIPTION NEXT TO THEM FOR ACTION AND MADNESS
 * EXPLAINING WHAT CHANGES THE VARIATION OF THE GAME."
 *
 * The phone cards (spade PLO, four-bay PLO, spade NLH), the desktop board row
 * and the desktop premium card all print the note beside the style line.
 * Classic is the standard game and prints none.
 */

// This fixture verifies printed game descriptions. Warming real table sockets
// escapes the fixture and leaves asynchronous network logs after teardown.
vi.mock('../../src/services/tableWarmup', () => ({
  observeLobbyTableWarmups: vi.fn(() => () => {}),
  warmTable: vi.fn(),
}));

vi.mock('../../src/hooks/useSpinTierAvailability', () => ({
  useSpinTierAvailability: () => ({ can_draw_100x: false }),
}));

// Dan 2026-10-16: the real minimum VPIP, not "VPIP Floor" / "High VPIP Floor",
// and bombs every 20 minutes for Action and every 10 for Madness.
const ACTION_NOTE = 'Big Blind Ante, 40% Minimum VPIP';
const MADNESS_NOTE = ACTION_NOTE;

const table = (over: Partial<LobbyTableRow>): LobbyTableRow =>
  ({
    id: 't',
    name: 'PLO 1/2 Action',
    game_variant: 'plo4',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 100,
    max_buy_in: 400,
    current_players: 0,
    max_players: 6,
    status: 'open',
    ...over,
  }) as LobbyTableRow;

const actions: ArenaGameCardActions = {
  primaryLabel: 'Join Game',
  onPrimary: () => {},
  secondaryLabel: 'View Game',
  onSecondary: () => {},
};

const card = (over: Partial<ArenaGameCardData>): ArenaGameCardData => ({
  id: 't1',
  family: 'plo',
  title: 'PLO 1/2',
  subtitle: 'Lightning Games',
  styleNote: ACTION_NOTE,
  gameType: 'PLO',
  stakes: '1/2',
  players: '0',
  buyIn: '100 - 400',
  status: 'open',
  statusLabel: 'Empty',
  rules: [],
  ...over,
});

describe('the note is the template blurb, and only Action and Madness have one', () => {
  it('Action and Madness read their blurb without the full stop; Classic reads nothing', () => {
    expect(cashTemplateNote('action')).toBe(ACTION_NOTE);
    expect(cashTemplateNote('MADNESS')).toBe(MADNESS_NOTE);
    expect(cashTemplateNote('classic')).toBeNull();
    expect(cashTemplateNote(null)).toBeNull();
    expect(cashTemplateNote('turbo')).toBeNull();
    for (const t of CASH_TEMPLATES) {
      const note = cashTemplateNote(t.id);
      if (note) expect(t.blurb.startsWith(note)).toBe(true);
    }
  });

  it('every word of a note starts with a capital and there is no em dash', () => {
    for (const note of [ACTION_NOTE, MADNESS_NOTE]) {
      expect(note.includes(String.fromCharCode(0x2014))).toBe(false);
      for (const word of note.split(/[\s,]+/).filter(Boolean)) {
        expect(word[0]).toBe(word[0].toUpperCase());
      }
    }
  });
});

describe('the lobby card data carries the note for the game it describes', () => {
  const entry = (template: string | null) =>
    cashEntry(
      table({
        cluster_id: 'g',
        cluster_template: template,
        name: `PLO 1/2 ${template ?? ''}`.trim(),
      } as Partial<LobbyTableRow>)
    );

  it('an Action game and a Madness game each get their own note', () => {
    expect(arenaGameCardDataFromEntry(entry('action')).styleNote).toBe(ACTION_NOTE);
    expect(arenaGameCardDataFromEntry(entry('madness')).styleNote).toBe(MADNESS_NOTE);
  });

  it("an NLH game named for its style never prints No Limit Hold'em again (Dan 2026-10-16)", () => {
    for (const template of ['action', 'madness', 'classic']) {
      const data = arenaGameCardDataFromEntry(
        cashEntry(
          table({
            cluster_id: 'g',
            cluster_template: template,
            name: `NLH 0.25/0.50 ${template[0].toUpperCase()}${template.slice(1)}`,
            game_variant: 'nlh',
          } as Partial<LobbyTableRow>)
        )
      );
      expect(data.subtitle ?? '').not.toMatch(/hold.?em/i);
    }
    const action = arenaGameCardDataFromEntry(
      cashEntry(
        table({
          cluster_id: 'g',
          cluster_template: 'action',
          name: 'NLH 0.25/0.50 Action',
          game_variant: 'nlh',
        } as Partial<LobbyTableRow>)
      )
    );
    expect(action.styleNote).toBe(ACTION_NOTE);
  });

  it('a Classic game and an untemplated table get none', () => {
    expect(arenaGameCardDataFromEntry(entry('classic')).styleNote).toBeUndefined();
    expect(arenaGameCardDataFromEntry(entry(null)).styleNote).toBeUndefined();
  });
});

describe('the phone cards print the note next to the style', () => {
  for (const [name, Card] of [
    ['spade PLO', SpadePloCard],
    ['four-bay PLO', PloFourBayCard],
    ['spade NLH', NlhPremiumCard],
  ] as const) {
    it(`${name}: the style word and its note share the subtitle row`, () => {
      const { container } = render(
        <Card data={card({ family: name.includes('NLH') ? 'nlh' : 'plo' })} actions={actions} />
      );
      const row = container.querySelector('[data-zone="subtitle"]');
      expect(row).not.toBeNull();
      expect(row!.textContent).toContain('Lightning Games');
      const note = row!.querySelector('[data-zone="styleNote"]');
      expect(note?.textContent).toBe(ACTION_NOTE);
    });

    it(`${name}: Classic keeps the plain subtitle and prints no note`, () => {
      const { container } = render(
        <Card
          data={card({
            family: name.includes('NLH') ? 'nlh' : 'plo',
            subtitle: 'Classic',
            styleNote: undefined,
          })}
          actions={actions}
        />
      );
      expect(container.querySelector('[data-zone="subtitle"]')?.textContent).toBe('Classic');
      expect(container.querySelector('[data-zone="styleNote"]')).toBeNull();
    });
  }
});

describe('the desktop board prints the note after the style word', () => {
  const ctx = {
    waitlistedIds: new Set<string>(),
    seatedIds: new Set<string>(),
    registeredIds: new Set<string>(),
    favoriteIds: new Set<string>(),
  };

  it('Action and Madness rows say what they change; the Classic row does not', () => {
    render(
      <MemoryRouter>
        <LobbyTable
          entries={[
            cashEntry(
              table({
                id: 'c',
                name: 'PLO 1/2 Classic',
                cluster_id: 'gc',
                cluster_template: 'classic',
              } as Partial<LobbyTableRow>)
            ),
            cashEntry(
              table({
                id: 'a',
                name: 'PLO 1/2 Action',
                cluster_id: 'ga',
                cluster_template: 'action',
              } as Partial<LobbyTableRow>)
            ),
            cashEntry(
              table({
                id: 'm',
                name: 'PLO 1/2 Madness',
                cluster_id: 'gm',
                cluster_template: 'madness',
              } as Partial<LobbyTableRow>)
            ),
          ]}
          category="OMAHA"
          selectedId={null}
          onSelect={() => {}}
          onActivate={() => {}}
          ctx={ctx}
        />
      </MemoryRouter>
    );
    expect(screen.getAllByText(ACTION_NOTE).length).toBeGreaterThan(0);
    expect(screen.getAllByText(MADNESS_NOTE).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No Antes, No Bombs/)).toBeNull();
  });
});

describe('the desktop board never cuts the note short (2026-10-17)', () => {
  it('the table-name line wraps instead of clipping', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/components/lobby/LobbyTable.css', 'utf8');
    const at = css.indexOf('.lt-name__table {');
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toContain('white-space: normal');
    expect(rule).toContain('overflow-wrap: anywhere');
  });
});
