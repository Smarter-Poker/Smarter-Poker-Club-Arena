import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ClubLobbyCommandTop from '../../src/components/lobby/ClubLobbyCommandTop';

describe('Diamond Arena campaign ownership', () => {
  it('does not offer a chip-club promotion or a route the arena refuses', () => {
    const source = readFileSync('src/pages/ClubHomePage.tsx', 'utf8');
    const campaign = source.slice(source.indexOf('          campaign={'));
    expect(campaign).toMatch(/^\s*campaign=\{\s*!isAutomaticArena && \(/);
    expect(campaign).toContain('navigate(`/clubs/${clubId}/announcements`)');
  });

  it('omits the campaign well when the room has no supported campaign', () => {
    const { container } = render(
      <ClubLobbyCommandTop
        welcome={<span>Diamond Arena</span>}
        controls={<span>Games</span>}
        campaign={false}
      />
    );
    expect(screen.getByText('Games')).toBeTruthy();
    expect(container.querySelector('.club-lobby-command-top__campaign')).toBeNull();
  });

  it('retains a chip club campaign and its action', () => {
    render(
      <ClubLobbyCommandTop
        welcome={null}
        controls={null}
        campaign={<button>Open Club Promotions</button>}
      />
    );
    expect(screen.getByRole('button', { name: 'Open Club Promotions' })).toBeTruthy();
  });
});
