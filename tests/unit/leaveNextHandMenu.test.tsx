import { describe, expect, it, vi } from 'vitest';
import { createDefaultMenuSections } from '../../src/components/table/TableMenu';

describe('Leave Table Next Hand menu action', () => {
  it('routes to its own handler without leaving immediately', () => {
    const immediate = vi.fn();
    const nextHand = vi.fn();
    const actions = createDefaultMenuSections({
      onLeaveTable: immediate,
      onLeaveTableNextHand: nextHand,
    }).flatMap((section) => section.actions);
    const action = actions.find((item) => item.id === 'leave-next-hand')!;
    expect(action.label).toBe('Leave Table Next Hand');
    expect(action.disabled).toBe(false);
    action.onClick();
    expect(nextHand).toHaveBeenCalledOnce();
    expect(immediate).not.toHaveBeenCalled();
  });

  it('disables the action when the surface has no next-hand handler', () => {
    const action = createDefaultMenuSections({})
      .flatMap((section) => section.actions)
      .find((item) => item.id === 'leave-next-hand')!;
    expect(action.disabled).toBe(true);
  });
});
