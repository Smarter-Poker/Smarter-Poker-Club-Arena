import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import LightningEntrySurface from '../../src/components/lightning/LightningEntrySurface';
import LightningMySessions from '../../src/components/lightning/LightningMySessions';
import { lightningStakeText } from '../../src/lightning/lightningStakeText';
import { lightningRoomPath } from '../../src/lightning/lightningSession';

afterEach(cleanup);

describe('the Lightning entry stays on its approved frame', () => {
  it('keeps the game, remembered tables and both working doors inside one chassis', () => {
    const join = vi.fn(),
      back = vi.fn(),
      open = vi.fn();
    const { container } = render(
      <LightningEntrySurface
        title="PLO5 1.00 / 2.00 Lightning Games"
        description="Blinds 1/2. Buy In Once And Play One Stream Of Hands."
        action={{ label: 'Join Lightning', onClick: join }}
        secondaryAction={{ label: 'Return To Lobby', onClick: back }}
      >
        <LightningMySessions
          rows={[]}
          currentClusterId="current"
          limit={4}
          lastPlayed={{
            clusterId: 'last',
            name: 'NLH 1.00/2.00 Lightning Games',
            stakes: '1.00/2.00',
          }}
          onViewGame={vi.fn()}
          onOpenCluster={open}
        />
      </LightningEntrySurface>
    );
    expect(container.querySelectorAll('.sc')).toHaveLength(1);
    expect(
      container.querySelector('.sc__body [data-testid="lightning-my-sessions"]')
    ).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'PLO5 1/2 Lightning Games' })).toBeTruthy();
    expect(container.textContent).not.toContain('1.00');
    expect(screen.getByTestId('lightning-last-played').textContent?.match(/1\/2/g)).toHaveLength(1);
    fireEvent.click(
      within(container.querySelector('.sc__foot') as HTMLElement).getByRole('button', {
        name: 'Join Lightning',
        exact: true,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Return To Lobby' }));
    fireEvent.click(screen.getByTestId('lightning-last-played-open'));
    expect(join).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('last');
  });

  it('keeps a closed join disabled on the painted plate', () => {
    const join = vi.fn();
    render(
      <LightningEntrySurface
        title="PLO 1/2"
        action={{ label: 'Join Lightning', onClick: join, disabled: true, testId: 'closed-join' }}
        secondaryAction={{ label: 'Return To Lobby', onClick: vi.fn() }}
      />
    );
    fireEvent.click(screen.getByTestId('closed-join'));
    expect(join).not.toHaveBeenCalled();
    expect(screen.getByTestId('closed-join').hasAttribute('disabled')).toBe(true);
  });

  it.each([
    ['NLH 1.00 / 2.00 Lightning Games', 'NLH 1/2 Lightning Games'],
    ['PLO 0.25/0.50', 'PLO 0.25/0.50'],
    ['5.00/10.00', '5/10'],
    ['PLO5', 'PLO5'],
  ])('prints accurate compact stakes: %s', (input, expected) => {
    expect(lightningStakeText(input)).toBe(expected);
  });

  it('the real route uses the chassis for every entry result and nests the table list', () => {
    const page = readFileSync('src/pages/LightningEntryPage.tsx', 'utf8');
    expect(page).not.toMatch(/\bEmptyState\b/);
    expect(page).toMatch(
      /<LightningEntrySurface[\s\S]*<LightningMySessions[\s\S]*<\/LightningEntrySurface>/
    );
    expect(page).toContain('mine.rows && !mine.failed');
  });

  it('carries compact stakes into the opened Lightning table tab', () => {
    const path = lightningRoomPath('pool', {
      clusterId: 'cluster',
      clubId: null,
      name: 'PLO5 1.00/2.00 Lightning Games',
      variant: 'plo5',
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 6,
      clusterMode: 'lightning',
      enabled: true,
    });
    const query = new URL(path, 'https://example.test').searchParams;
    expect(query.get('name')).toBe('PLO5 1/2 Lightning Games');
    expect(query.get('stakes')).toBe('1/2');
  });
});
