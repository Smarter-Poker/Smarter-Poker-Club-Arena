import { afterEach, describe, expect, it } from 'vitest';
import {
  CASH_SPECTATOR_ACTION,
  CASH_TABLE_CARD_SELECTOR,
  collectVisibleCashCandidates,
  selectClassicCashCandidate,
} from '../e2e/support/cashTableCandidates';

const TABLE = '11111111-1111-4111-8111-111111111111';

function card({
  target = 'game',
  label = 'View Game',
  players = 4,
  kind = 'cash',
  live = true,
  disabled = false,
  hidden = false,
  width = 44,
  compact = false,
} = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'club-home__games';
  const entry = document.createElement('div');
  entry.dataset.testid = compact ? 'lobby-game-row' : 'arena-lobby-game-card';
  entry.dataset.id = TABLE;
  entry.dataset.kind = kind;
  entry.dataset.target = target;
  entry.dataset.live = String(live);
  entry.dataset.players = String(players);
  const button = document.createElement('button');
  button.setAttribute('aria-label', label);
  if (compact) button.className = 'compact-lobby__open';
  button.disabled = disabled;
  if (hidden) button.style.display = 'none';
  button.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width,
    height: 44,
    right: width,
    bottom: 44,
    toJSON() {},
  });
  entry.appendChild(button);
  wrapper.appendChild(entry);
  document.body.appendChild(wrapper);
  return collectVisibleCashCandidates(
    [...document.querySelectorAll(CASH_TABLE_CARD_SELECTOR)],
    CASH_SPECTATOR_ACTION.source
  );
}

afterEach(() => document.body.replaceChildren());

describe('production cash spectator candidate selection', () => {
  it('accepts read-only Details on a compact row before the separate View action', () => {
    expect(card({ compact: true, label: 'Details: NLH 1/2' })).toHaveLength(1);
  });
  it.each(['View Game', 'Watch Game'])('accepts the published cluster %s control', (label) => {
    expect(card({ label })).toEqual([{ id: TABLE, name: TABLE, players: 4 }]);
  });

  it.each(['View Table', 'Watch Table'])('keeps manual %s controls eligible', (label) => {
    expect(card({ target: 'table', label })).toHaveLength(1);
  });

  it.each(['Join Game', 'Join Table', 'Join Waitlist', 'Return To Game'])(
    'never selects the participation control %s',
    (label) => {
      expect(card({ label })).toEqual([]);
    }
  );

  it.each([
    { players: 1 },
    { kind: 'mtt' },
    { live: false },
    { disabled: true },
    { hidden: true },
    { width: 0 },
    { target: 'tournament' },
  ])('rejects an ineligible card or inaccessible action: %j', (options) => {
    expect(card(options)).toEqual([]);
  });
});

const ORDINARY = '22222222-2222-4222-8222-222222222222';
const CLUSTER = '33333333-3333-4333-8333-333333333333';
const candidates = [
  { id: TABLE, players: 9 },
  { id: ORDINARY, players: 4 },
];
const ordinary = { id: ORDINARY, cluster_id: CLUSTER, cluster: { cluster_mode: 'must_move' } };

describe('classic hero subject mode', () => {
  it('selects the exact ordinary-mode row instead of the busier Lightning table', () => {
    expect(
      selectClassicCashCandidate(candidates, [
        { id: TABLE, cluster_id: CLUSTER, cluster: { cluster_mode: 'lightning' } },
        ordinary,
      ])
    ).toEqual(candidates[1]);
  });
  it.each(['lightning', 'pending_on', 'pending_off', 'draining', 'unknown', null, undefined])(
    'refuses nonordinary or unknown mode %s',
    (mode) => {
      expect(
        selectClassicCashCandidate(
          [candidates[0]],
          [{ id: TABLE, cluster_id: CLUSTER, cluster: { cluster_mode: mode } }]
        )
      ).toBeUndefined();
    }
  );
  it.each([
    {},
    { id: TABLE },
    { id: TABLE, cluster_id: CLUSTER },
    { id: TABLE, cluster_id: 'bad', cluster: { cluster_mode: 'must_move' } },
    { id: TABLE, cluster_id: CLUSTER, cluster: null },
    { id: TABLE, cluster_id: CLUSTER, cluster: [{ cluster_mode: 'must_move' }] },
    { id: ORDINARY, cluster_id: CLUSTER, cluster: { cluster_mode: 'must_move' } },
  ])('refuses missing, malformed or mismatched catalogue authority %j', (row) => {
    expect(selectClassicCashCandidate([candidates[0]], [row])).toBeUndefined();
  });
  it('refuses duplicate catalogue identity rather than choosing one mode', () => {
    expect(() =>
      selectClassicCashCandidate(candidates, [
        ordinary,
        { ...ordinary, cluster: { cluster_mode: 'lightning' } },
      ])
    ).toThrow('Duplicate cash catalogue identity');
  });
});
