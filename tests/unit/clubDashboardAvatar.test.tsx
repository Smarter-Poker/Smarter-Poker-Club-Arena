import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ClubDashboardAvatar from '../../src/components/club/ClubDashboardAvatar';

describe('Club Dashboard Avatar', () => {
  it('replaces an unavailable stored logo with the club initial', () => {
    render(<ClubDashboardAvatar src="/missing-logo.png" name="Club JAQK" />);
    fireEvent.error(screen.getByRole('img', { name: 'Club JAQK' }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('C')).toBeTruthy();
  });

  it('tries a changed logo after the previous source failed', () => {
    const { rerender } = render(<ClubDashboardAvatar src="/old.png" name="Club JAQK" />);
    fireEvent.error(screen.getByRole('img'));
    rerender(<ClubDashboardAvatar src="/new.png" name="Club JAQK" />);
    expect(screen.getByRole('img').getAttribute('src')).toBe('/new.png');
  });

  it('uses the current club initial when no logo is configured', () => {
    const { rerender } = render(<ClubDashboardAvatar name="Club JAQK" />);
    expect(screen.getByText('C')).toBeTruthy();
    rerender(<ClubDashboardAvatar name="Shark Club" />);
    expect(screen.getByText('S')).toBeTruthy();
  });
});
