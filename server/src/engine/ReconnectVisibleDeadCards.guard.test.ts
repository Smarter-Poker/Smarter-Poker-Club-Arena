import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const ENGINE = readFileSync(join(__dirname, 'ServerTableEngine.ts'), 'utf8');

describe('public dead-card reconnect contract', () => {
  it('publishes exposed dead cards on observer, resync, live, and idle snapshots', () => {
    expect(sliceMethod(ENGINE, 'public getObserverState(')).toContain(
      'revealed_dead_cards: state.revealedDeadCards ?? []'
    );
    expect(sliceMethod(ENGINE, 'public getTableState(')).toContain(
      'revealed_dead_cards: state.revealedDeadCards ?? []'
    );
    expect(sliceMethod(ENGINE, 'protected broadcastCurrentState()')).toContain(
      'revealed_dead_cards: state.revealedDeadCards ?? []'
    );
    expect(sliceMethod(ENGINE, 'protected publishIdleState()')).toContain(
      'revealed_dead_cards: []'
    );
  });
});
