import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AchievementBadge from '../../src/components/achievements/AchievementBadge';
afterEach(cleanup);
describe('Achievement Badge Progress', () => {
  it('keeps the percentage outside the clipping meter and exposes its live value', () => {
    render(
      <AchievementBadge
        icon="★"
        name="Tournament Milestone"
        description="Win Events"
        progress={63}
      />
    );
    const meter = screen.getByRole('progressbar', { name: 'Tournament Milestone Progress' });
    expect(meter.getAttribute('aria-valuenow')).toBe('63');
    expect(meter.contains(screen.getByText('63% Complete'))).toBe(false);
    expect(meter.parentElement?.contains(screen.getByText('63% Complete'))).toBe(true);
  });
});
