import { describe, expect, it } from 'vitest';
import { createTableStateMachine } from './StateMachine.js';

describe('a table stopped while paused closes', () => {
  it('walks paused -> closing -> closed without an invalid transition', () => {
    // 2026-10-02: 34 refused paused -> closing (and the closed that followed)
    // per hour, from tournament tables broken during their own break.
    const fsm = createTableStateMachine('running');
    expect(fsm.transition('paused')).toBe(true);
    expect(fsm.transition('closing')).toBe(true);
    expect(fsm.transition('closed')).toBe(true);
    expect(fsm.state).toBe('closed');
  });
});
