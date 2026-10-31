import { describe, expect, it } from 'vitest';
import { tableHudControl } from '../../src/components/table/tableHudControl';

const completed = {
  heroPromptedToAct: false,
  handSettling: true,
  handInProgress: true,
  rabbitAvailable: true,
  rabbitEnabled: true,
};

describe('the final fold opens Rabbit Hunt without waiting for the result hold', () => {
  it('shows the accepted offer while the final snapshot still retains the hand', () => {
    expect(tableHudControl(completed)).toBe('rabbit');
  });
  it('releases a stale turn prompt when the hand-complete event has arrived', () => {
    expect(tableHudControl({ ...completed, heroPromptedToAct: true })).toBe('rabbit');
  });
  it('keeps a real new-hand decision ahead of a retained older offer', () => {
    expect(tableHudControl({ ...completed, handSettling: false, heroPromptedToAct: true })).toBe(
      'timebank'
    );
    expect(tableHudControl({ ...completed, handSettling: false })).toBeNull();
  });
  it('requires the authoritative eligible offer and the player setting', () => {
    expect(tableHudControl({ ...completed, rabbitAvailable: false })).toBeNull();
    expect(tableHudControl({ ...completed, rabbitEnabled: false })).toBeNull();
  });
  it('keeps the offer usable after the hand-free snapshot arrives', () => {
    expect(tableHudControl({ ...completed, handInProgress: false })).toBe('rabbit');
  });
});
