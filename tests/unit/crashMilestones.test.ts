import { describe, expect, it } from 'vitest';
import { CRASH_MILESTONES_CENTS, crossedMilestone } from '../../src/utils/crashMilestones';

describe('crossedMilestone', () => {
  it('says a mark once, on the frame that reaches it', () => {
    expect(crossedMilestone(199, 200)).toBe(200);
    expect(crossedMilestone(200, 201)).toBeNull();
    expect(crossedMilestone(120, 140)).toBeNull();
  });

  it('says only the newest mark when one slow frame passes several', () => {
    expect(crossedMilestone(140, 520)).toBe(500);
  });

  it('never speaks on the way down, and the marks rise', () => {
    expect(crossedMilestone(600, 300)).toBeNull();
    expect([...CRASH_MILESTONES_CENTS]).toEqual([...CRASH_MILESTONES_CENTS].sort((a, b) => a - b));
  });
});
