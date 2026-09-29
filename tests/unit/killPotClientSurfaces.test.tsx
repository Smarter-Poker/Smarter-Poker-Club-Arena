/**
 * KILL AND HALF-KILL POTS ON THE CLIENT (rule manifest kill-v1).
 *
 * The engine decides everything about a kill: whether the next hand is one,
 * who the killer is, the effective limits and the kill blind. The client maps
 * those facts through the one snapshot mapper, draws them (the felt pill, the
 * next-hand line, the killer's seat marker), sizes the fixed-limit wager from
 * the server's numbers, rebuilds the kill blind in the hand history, and
 * describes the table's rule where a player reads rules. This file pins each
 * of those, and that none of them does kill arithmetic of its own.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@/components/table/CardImage', () => ({
  default: () => <span />,
  CardImage: () => <span />,
  CardBack: () => <span />,
}));

import { mapEngineSnapshot } from '../../src/utils/mapEngineSnapshot';
import {
  fixedLimitStreetBet,
  killNextAnnouncement,
  killPotPillText,
  killRuleLinePart,
  parseKillHand,
  parseKillNext,
} from '../../src/utils/killPot';
import { buildReplay, replayInputFromRow } from '../../src/utils/handReplay';
import { HandDetailView } from '../../src/components/handdetail/HandDetailView';
import { GameRulesModal } from '../../src/components/table/GameRulesModal';
import SeatSlot from '../../src/components/table/SeatSlot';
import { cashRuleMedallions } from '../../src/components/lobby/lobbyEntries';
import {
  FILTER_SPECS,
  emptyFilterValue,
  featureState,
  rowPassesFilter,
  type FilterableRow,
} from '../../src/components/lobby/advancedFilterSpec';
import { rulesLineFor } from '../../src/components/cash/CashGameCard';

afterEach(cleanup);

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TABLE_PAGE = read('src/pages/TablePage.tsx');
const CLUB_HOME = read('src/pages/ClubHomePage.tsx');

/** The engine's kill_hand / kill_next payloads (killPotSnapshotFields). */
const KILL_HAND = {
  mode: 'full',
  small_bet: 8,
  big_bet: 16,
  kill_blind: 8,
  killer_seat: 3,
  killer_user_id: 'u3',
  killer_blind_slot: 'none',
  chained: false,
};
const KILL_NEXT = {
  mode: 'half',
  small_bet: 6,
  big_bet: 12,
  kill_blind: 6,
  killer_seat: 2,
  killer_user_id: 'u2',
};

const snapshot = (extra: Record<string, unknown>) =>
  ({
    table_id: 't-1',
    pot: 0,
    current_bet: 0,
    stage: 'preflop',
    dealer_seat: 1,
    players: [],
    action_history: [],
    community_cards: [],
    pots: [],
    winners: [],
    disconnect_states: {},
    ...extra,
  }) as unknown as Parameters<typeof mapEngineSnapshot>[0];

// ─────────────────────────────────────────────────────────────────────────────
describe('the snapshot mapper carries the engine kill facts', () => {
  it('maps kill_hand and kill_next to camelCase, number for number', () => {
    const m = mapEngineSnapshot(snapshot({ kill_hand: KILL_HAND, kill_next: KILL_NEXT }), 'h', 6);
    expect(m.killHand).toEqual({
      mode: 'full',
      smallBet: 8,
      bigBet: 16,
      killBlind: 8,
      killerSeat: 3,
      killerUserId: 'u3',
      killerBlindSlot: 'none',
      chained: false,
    });
    expect(m.killNext).toEqual({
      mode: 'half',
      smallBet: 6,
      bigBet: 12,
      killBlind: 6,
      killerSeat: 2,
      killerUserId: 'u2',
    });
  });

  it('maps an absent, null or malformed field to null, never to a guessed kill', () => {
    const none = mapEngineSnapshot(snapshot({}), 'h', 6);
    expect(none.killHand).toBeNull();
    expect(none.killNext).toBeNull();
    const nulls = mapEngineSnapshot(snapshot({ kill_hand: null, kill_next: null }), 'h', 6);
    expect(nulls.killHand).toBeNull();
    expect(nulls.killNext).toBeNull();
    expect(parseKillHand({ ...KILL_HAND, mode: 'off' })).toBeNull();
    expect(parseKillHand({ ...KILL_HAND, small_bet: null })).toBeNull();
    expect(parseKillNext({ ...KILL_NEXT, killer_seat: 0 })).toBeNull();
    // A pending kill the engine could not size still announces; its sizes are null.
    expect(parseKillNext({ ...KILL_NEXT, small_bet: null })?.smallBet).toBeNull();
  });

  it('the table page adopts both fields from the mapper on every snapshot', () => {
    expect(TABLE_PAGE).toContain('killHand: mapped.killHand,');
    expect(TABLE_PAGE).toContain('killNext: mapped.killNext,');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the felt says it: pill, next-hand line and the killer marker', () => {
  it('names the kill and its effective limits', () => {
    expect(killPotPillText({ mode: 'full', smallBet: 8, bigBet: 16 })).toBe('Kill Pot 8/16');
    expect(killPotPillText({ mode: 'half', smallBet: 6, bigBet: 12 })).toBe('Half Kill 6/12');
    expect(killPotPillText({ mode: 'half', smallBet: 0.3, bigBet: 0.6 })).toBe('Half Kill 0.3/0.6');
    expect(killNextAnnouncement({ mode: 'full' })).toBe('Next Hand Is A Kill Pot');
    expect(killNextAnnouncement({ mode: 'half' })).toBe('Next Hand Is A Half Kill');
  });

  it('draws the pill in the live bomb pill and the line in the bomb clock line', () => {
    // The bomb pot pill pattern is the model: same classes, same anchors.
    expect(TABLE_PAGE).toMatch(
      /className="bomb-pot-live kill-pot-live"[\s\S]{0,400}killPotPillText\(tableState\.killHand\)/
    );
    expect(TABLE_PAGE).toMatch(
      /table-brand__line table-brand__line--bomb[^"]*table-brand__line--kill[\s\S]{0,300}killNextAnnouncement\(tableState\.killNext\)/
    );
    expect(TABLE_PAGE).toMatch(
      /killMarker=\{\s*tableState\.killHand\?\.killerSeat === seatNumber \? 'Kill Blind' : null\s*\}/
    );
  });

  it('the killer seat wears a Kill Blind marker beside its position badge', () => {
    const player = {
      id: 'u3',
      name: 'KILLER',
      stack: 500,
      status: 'active' as const,
      showCards: false,
      isHero: false,
    };
    const { container, rerender } = render(
      <SeatSlot
        seatNumber={3}
        player={player}
        position={'SB' as never}
        killMarker="Kill Blind"
        isActive={false}
        lastAction={null as never}
      />
    );
    const marker = container.querySelector('.seat__kill-badge');
    expect(marker?.textContent).toBe('Kill Blind');
    // A killer in a blind keeps both badges: the text says which is which.
    expect(container.querySelector('.seat__position-badge--sb')?.textContent).toBe('SB');
    rerender(
      <SeatSlot
        seatNumber={3}
        player={player}
        position={'SB' as never}
        killMarker={null}
        isActive={false}
        lastAction={null as never}
      />
    );
    expect(container.querySelector('.seat__kill-badge')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the action panel sizes a fixed-limit wager from the server', () => {
  const kill = { smallBet: 8, bigBet: 16 };

  it('the published fixed_bet_size wins on every street, kill hand or not', () => {
    for (const stage of ['preflop', 'flop', 'turn', 'river']) {
      expect(fixedLimitStreetBet({ serverBetSize: 8, killHand: null, bigBlind: 4, stage })).toBe(8);
      expect(fixedLimitStreetBet({ serverBetSize: 16, killHand: kill, bigBlind: 4, stage })).toBe(
        16
      );
    }
  });

  it('on a kill hand without the field it reads the published kill limits, never the base big blind', () => {
    expect(fixedLimitStreetBet({ killHand: kill, bigBlind: 4, stage: 'preflop' })).toBe(8);
    expect(fixedLimitStreetBet({ killHand: kill, bigBlind: 4, stage: 'flop' })).toBe(8);
    expect(fixedLimitStreetBet({ killHand: kill, bigBlind: 4, stage: 'turn' })).toBe(16);
    expect(fixedLimitStreetBet({ killHand: kill, bigBlind: 4, stage: 'river' })).toBe(16);
  });

  it('a base-limit hand from an older engine still derives from the big blind', () => {
    expect(fixedLimitStreetBet({ killHand: null, bigBlind: 4, stage: 'preflop' })).toBe(4);
    expect(fixedLimitStreetBet({ killHand: null, bigBlind: 4, stage: 'turn' })).toBe(8);
  });

  it('both sizing sites in the table page go through it; no bare big-blind fallback is left', () => {
    expect(TABLE_PAGE).not.toMatch(/fixedLimitBetSize\(/);
    expect(TABLE_PAGE.match(/fixedLimitStreetBet\(\{/g)?.length).toBe(2);
    expect(TABLE_PAGE.match(/killHand: tableState\.killHand,/g)?.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * A full kill at base 2/4 (blinds 1/2): limits 4/8, kill blind 4, killer on
 * the button in seat 1. The engine writes the forced posts itself.
 */
const KILL_ROW = {
  id: 'h-1',
  hand_number: 10,
  created_at: '2026-09-23T12:00:00Z',
  game_variant: 'flh',
  small_blind: 1,
  big_blind: 2,
  pot_size: 18,
  rake_amount: 0,
  button_seat: 1,
  community_cards: [],
  players: [
    { userId: 'u1', username: 'Alice', seat: 1, stack: 100 },
    { userId: 'u2', username: 'Bob', seat: 2, stack: 100 },
    { userId: 'u3', username: 'Cara', seat: 3, stack: 100 },
  ],
  actions: [
    { seat: 2, userId: 'u2', action: 'sb', amount: 1, stage: 'preflop', dead: false },
    { seat: 3, userId: 'u3', action: 'bb', amount: 2, stage: 'preflop', dead: false },
    { seat: 1, userId: 'u1', action: 'kill_blind', amount: 4, stage: 'preflop', dead: false },
    { seat: 2, userId: 'u2', action: 'raise', amount: 8, stage: 'preflop' },
    { seat: 3, userId: 'u3', action: 'fold', amount: 0, stage: 'preflop' },
    { seat: 1, userId: 'u1', action: 'call', amount: 4, stage: 'preflop' },
  ],
  winners: [{ userId: 'u2', amount: 18, potIndex: 0 }],
  kill_pot: {
    rule_version: 'kill-v1',
    kill_hand: {
      mode: 'full',
      multiplier: '2/1',
      base_big_blind: 2,
      small_bet: 4,
      big_bet: 8,
      kill_blind: 4,
      killer_user_id: 'u1',
      killer_seat: 1,
      killer_blind_slot: 'none',
      trigger_hand_id: 'h-0',
      trigger_hand_number: 9,
      chained: false,
    },
    next_kill: null,
    cancelled: null,
  },
};

describe('hand history rebuilds a kill hand and says what the kill was', () => {
  const model = buildReplay(replayInputFromRow(KILL_ROW));
  const preflop = model.streets.find((s) => s.key === 'preflop')!;

  it('draws the kill blind as a live forced post labelled Kill Blind', () => {
    const post = preflop.rows.find((r) => r.verb === 'kill_blind')!;
    expect(post).toBeDefined();
    expect(post.label).toBe('Kill Blind');
    expect(post.amount).toBe(4);
    expect(post.dead).toBe(false);
    // The log carried its own blinds, so none were synthesised on top.
    expect(preflop.rows.filter((r) => r.key.startsWith('post-'))).toEqual([]);
  });

  it('differences the raise against the posted blind and lands on the stored pot', () => {
    const raise = preflop.rows.find((r) => r.verb === 'raise')!;
    expect(raise.amount).toBe(7);
    expect(model.rebuiltPot).toBe(18);
    expect(model.reconciles).toBe(true);
  });

  it('carries base and effective limits and the killer from the record', () => {
    expect(model.killPot?.hand).toEqual({
      mode: 'full',
      name: 'Kill Pot',
      baseLimits: '2/4',
      effectiveLimits: '4/8',
      killBlind: 4,
      killerUserId: 'u1',
      killerName: 'Alice',
      killerSeat: 1,
      chained: false,
    });
    expect(model.killPot?.cancelled).toBeNull();
  });

  it('a hand with no kill facts has no kill in its model', () => {
    const plain = buildReplay(replayInputFromRow({ ...KILL_ROW, kill_pot: null }));
    expect(plain.killPot).toBeNull();
  });

  it('the rundown prints the kill, the limits, the kill blind and the killer', () => {
    const { container } = render(<HandDetailView model={model} />);
    const kill = container.querySelector('.hdv__kill')!;
    expect(kill.textContent).toContain('Kill Pot');
    expect(kill.textContent).toContain('Limits 4/8');
    expect(kill.textContent).toContain('Base 2/4');
    expect(kill.textContent).toContain('Kill Blind 4.00');
    expect(kill.textContent).toContain('Killer Alice, Seat 1');
    expect(container.textContent).toContain('Kill Blind');
  });

  it('a cancelled kill says why, and the hand that set a kill names the killer', () => {
    const cancelled = buildReplay(
      replayInputFromRow({
        ...KILL_ROW,
        kill_pot: {
          rule_version: 'kill-v1',
          kill_hand: null,
          next_kill: {
            killer_user_id: 'u2',
            killer_seat: 2,
            mode: 'half',
            multiplier: '3/2',
            threshold_bb: 10,
            threshold_amount: 20,
            contested_total: 24,
            trigger_hand_id: null,
            trigger_hand_number: 10,
            chained: false,
            scoop: { winner: 'u2', pots: 1, awards: 1, boards: [1], low_awards: 0 },
          },
          cancelled: {
            reason: 'killer_not_dealt_in',
            killer_user_id: 'u3',
            killer_seat: 3,
            mode: 'full',
            trigger_hand_id: null,
            trigger_hand_number: 9,
          },
        },
      })
    );
    expect(cancelled.killPot?.hand).toBeNull();
    expect(cancelled.killPot?.cancelled).toEqual({
      reasonText: 'The Killer Was Not Dealt In',
      killerName: 'Cara',
      killerSeat: 3,
    });
    expect(cancelled.killPot?.next).toEqual({
      mode: 'half',
      name: 'Half Kill',
      killerName: 'Bob',
      killerSeat: 2,
    });
    const { container } = render(<HandDetailView model={cancelled} />);
    expect(container.textContent).toContain('Kill Cancelled');
    expect(container.textContent).toContain('The Killer Was Not Dealt In');
    expect(container.textContent).toContain('Next Hand: Half Kill');
  });

  it('hand history reads the column', () => {
    expect(read('src/services/HandHistoryService.ts')).toMatch(
      /'bomb_pot',[\s\S]{0,400}'kill_pot',/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the lobby: a Kill medallion on fixed-limit cards, and a Kill Pot chip', () => {
  const kills = (row: Record<string, unknown>) =>
    cashRuleMedallions(row as never).filter((m) => m.key === 'kill');

  it('prints Kill / Half Kill with the threshold on a fixed-limit card', () => {
    expect(kills({ game_variant: 'flh', kill_mode: 'full', kill_threshold_bb: 10 })).toEqual([
      expect.objectContaining({ label: 'KILL', detail: '10BB' }),
    ]);
    expect(kills({ game_variant: 'flo8', kill_mode: 'half', kill_threshold_bb: 15 })).toEqual([
      expect.objectContaining({ label: 'HALF KILL', detail: '15BB' }),
    ]);
  });

  it('prints nothing when off, when the row did not say, or off a fixed-limit game', () => {
    expect(kills({ game_variant: 'flh', kill_mode: 'off', kill_threshold_bb: 10 })).toEqual([]);
    expect(kills({ game_variant: 'flh' })).toEqual([]);
    expect(kills({ game_variant: 'nlh', kill_mode: 'full', kill_threshold_bb: 10 })).toEqual([]);
  });

  const limit = FILTER_SPECS.LIMIT;
  const chip = limit.features.find((f) => f.key === 'kill_pot')!;
  const row = (r: Record<string, unknown>): FilterableRow => ({
    variant: 'flh',
    price: 2,
    seats: 6,
    seatsTaken: 3,
    name: 'FLH 2/4',
    row: r,
    settings: {},
  });

  it('lives on the LIMIT tab only, keyed on kill_mode, behind the capability', () => {
    expect(chip).toMatchObject({
      label: 'Kill Pot',
      match: ['kill_mode'],
      capability: 'cash.fixed_limit.kill_pots',
    });
    for (const tab of ['HOLDEM', 'OMAHA', 'MTT', 'SPIN', 'SNG'] as const) {
      expect(FILTER_SPECS[tab].features.some((f) => /kill/i.test(`${f.key} ${f.label}`))).toBe(
        false
      );
    }
  });

  it('answers yes, no, or cannot tell', () => {
    expect(featureState(chip, { kill_mode: 'full' }, {})).toBe(true);
    expect(featureState(chip, { kill_mode: 'half' }, {})).toBe(true);
    expect(featureState(chip, { kill_mode: 'off' }, {})).toBe(false);
    expect(featureState(chip, { kill_mode: null }, {})).toBe(false);
    expect(featureState(chip, {}, {})).toBeNull();
  });

  it('never hides a row that cannot answer, and narrows on one that can', () => {
    const must = { ...emptyFilterValue(limit), mustHave: ['kill_pot'] };
    const hide = { ...emptyFilterValue(limit), hide: ['kill_pot'] };
    expect(rowPassesFilter(limit, must, row({}))).toBe(true);
    expect(rowPassesFilter(limit, hide, row({}))).toBe(true);
    expect(rowPassesFilter(limit, must, row({ kill_mode: 'full' }))).toBe(true);
    expect(rowPassesFilter(limit, must, row({ kill_mode: 'off' }))).toBe(false);
    expect(rowPassesFilter(limit, hide, row({ kill_mode: 'half' }))).toBe(false);
    expect(rowPassesFilter(limit, hide, row({ kill_mode: 'off' }))).toBe(true);
  });

  it('the lobby cash select actually carries the columns', () => {
    const select = CLUB_HOME.match(/'id, name, game_variant, stakes, [^']*'/)?.[0] ?? '';
    expect(select).toContain(' kill_mode,');
    expect(select).toContain(' kill_threshold_bb,');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the rules text describes kill-v1 where it is enabled', () => {
  const open = (variant: string, killPotRules: unknown) =>
    render(
      <GameRulesModal
        isOpen
        onClose={() => {}}
        variant={variant}
        stakes="2/4"
        minBuyIn={40}
        maxBuyIn={200}
        isCashTable
        killPotRules={killPotRules as never}
      />
    );

  it('Table Info lists the type, trigger, killer and unchanged blinds', () => {
    open('FLH', { mode: 'full', thresholdBb: 10 });
    fireEvent.click(screen.getByRole('button', { name: 'Table Info' }));
    const body = document.body.textContent ?? '';
    expect(body).toContain('Full Kill, Double Limits');
    expect(body).toContain('One Player Wins Every Pot Of A Hand Worth 10 Big Blinds Or More');
    expect(body).toContain('Posts A Live Kill Blind Of Two Big Blinds Next Hand');
    expect(body).toContain('The Small And Big Blinds Do Not Change');
  });

  it('Betting Limits explains the half kill in one paragraph', () => {
    open('FLO8', { mode: 'half', thresholdBb: 12 });
    fireEvent.click(screen.getAllByRole('button', { name: 'Betting Limits' })[0]);
    const body = document.body.textContent ?? '';
    expect(body).toContain('This Table Plays Half Kill Pots.');
    expect(body).toMatch(/Worth 12 Big Blinds Or More/);
    expect(body).toMatch(/One And A Half Times The Usual/);
  });

  it('says nothing about kills on a table that runs none', () => {
    open('FLH', null);
    fireEvent.click(screen.getByRole('button', { name: 'Table Info' }));
    expect(document.body.textContent).not.toMatch(/Kill/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Betting Limits' })[0]);
    expect(document.body.textContent).not.toMatch(/Kill/);
  });

  it('the cash card rule line carries it only when chosen', () => {
    expect(killRuleLinePart({ mode: 'full', thresholdBb: 10 })).toBe('Kill Pot At 10 BB');
    expect(rulesLineFor({ seats: 6, kill: { mode: 'half', thresholdBb: 8 } })).toContain(
      'Half Kill At 8 BB'
    );
    expect(rulesLineFor({ seats: 6 })).not.toMatch(/Kill/);
  });
});
