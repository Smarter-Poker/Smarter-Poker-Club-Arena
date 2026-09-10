import { afterEach, describe, expect, it } from 'vitest';
import {
  CASH_SPECTATOR_ACTION,
  CASH_TABLE_CARD_SELECTOR,
  collectVisibleCashCandidates,
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
} = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'club-home__games';
  const entry = document.createElement('div');
  entry.dataset.testid = 'arena-lobby-game-card';
  entry.dataset.id = TABLE;
  entry.dataset.kind = kind;
  entry.dataset.target = target;
  entry.dataset.live = String(live);
  entry.dataset.players = String(players);
  const button = document.createElement('button');
  button.setAttribute('aria-label', label);
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
