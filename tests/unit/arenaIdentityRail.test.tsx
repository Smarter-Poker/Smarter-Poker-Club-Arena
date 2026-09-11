/**
 * Dan 2026-09-11, verbatim: "HAVE IT SAY JUST 'ACTIVE' AND THE NUMBER UNDER
 * IT. AND THE FREE ROLL STARTS CLOCK."
 *
 * Diamond Arena is one open club. It has no join code to level up and no
 * membership to count, so the identity master's painted "PLAYING NOW" rail and
 * its level plate both say nothing true there. The arena rail replaces both
 * with the two figures that are true: who is playing now, and when the next
 * free seat is.
 *
 * The label it replaces is PAINT, not markup, so the rail has to be opaque and
 * has to sit over both zones. That is the part a later tidy-up would quietly
 * undo, so the geometry is pinned here alongside the behaviour.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClubIdentityCard,
  CLUB_IDENTITY_ZONES,
} from '../../src/components/club-buttons/ClubIdentityCard';
import { formatFreerollCountdown } from '../../src/hooks/useNextDiamondFreeroll';

const base = {
  clubName: 'Diamond Arena',
  pokerAlias: 'KingFish',
  clubId: 68294,
  playerId: 1,
};

describe('The arena identity rail', () => {
  it('prints ACTIVE with the count under it and the freeroll clock beside it', () => {
    render(
      <ClubIdentityCard
        {...base}
        level={1}
        playersPlaying={0}
        arenaStats={{
          activeCount: 1284,
          freerollText: '4:31',
          freerollTitle: 'Midnight Freeroll Starts 12:00 AM',
        }}
      />
    );
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect(screen.getByText('1,284')).toBeTruthy();
    expect(screen.getByText('FREEROLL')).toBeTruthy();
    expect(screen.getByRole('timer')).toHaveTextContent('4:31');
  });

  it('retires the painted playing rail and the level plate it sits over', () => {
    const { container } = render(
      <ClubIdentityCard
        {...base}
        level={9}
        playersPlaying={412}
        arenaStats={{ activeCount: 0, freerollText: '0:00', freerollTitle: 'No Freeroll' }}
      />
    );
    expect(container.querySelector('.club-identity__playing')).toBeNull();
    expect(container.querySelector('.club-identity__level')).toBeNull();
    expect(screen.queryByText('Level 9')).toBeNull();
  });

  it('leaves a chip club exactly as it was', () => {
    const { container } = render(
      <ClubIdentityCard {...base} clubName="Shark Club" level={29} playersPlaying={514} />
    );
    expect(container.querySelector('.club-identity__playing')).toBeTruthy();
    expect(screen.getByText('Level 29')).toBeTruthy();
    expect(container.querySelector('.club-identity__arena')).toBeNull();
    expect(screen.queryByText('ACTIVE')).toBeNull();
  });

  it('covers both painted zones completely', () => {
    const rail = CLUB_IDENTITY_ZONES.arenaStats;
    for (const zone of [CLUB_IDENTITY_ZONES.playing, CLUB_IDENTITY_ZONES.level]) {
      expect(zone.x, 'the rail starts left of the zone it covers').toBeGreaterThanOrEqual(rail.x);
      expect(zone.x + zone.width).toBeLessThanOrEqual(rail.x + rail.width);
      expect(zone.y).toBeGreaterThanOrEqual(rail.y);
      expect(zone.y + zone.height).toBeLessThanOrEqual(rail.y + rail.height);
    }
  });

  /* The playing zone starts two pixels above the share button's bottom edge,
     so a rail that covers it must clip that corner. Paint order is what keeps
     the button whole and clickable, and paint order is a line of JSX that a
     reorder would silently change. */
  it('paints the rail before the share button so the button stays on top', () => {
    const { container } = render(
      <ClubIdentityCard
        {...base}
        arenaStats={{ activeCount: 3, freerollText: '0:30', freerollTitle: 'Freeroll' }}
      />
    );
    const nodes = [...container.querySelectorAll('.club-identity__arena, .club-identity__share')];
    expect(nodes).toHaveLength(2);
    expect(nodes[0].className).toContain('club-identity__arena');
  });

  /* Both labels share a two-column rail inside about a third of the card, so
     each has roughly 48px. "NEXT FREEROLL" did not fit and shipped clipped to
     "NEXT FREEROL". Neither label may grow past the one that already fits. */
  it('keeps both rail labels short enough to fit the column they share', () => {
    render(
      <ClubIdentityCard
        {...base}
        arenaStats={{ activeCount: 0, freerollText: '0:00', freerollTitle: 'No Freeroll' }}
      />
    );
    const labels = [...document.querySelectorAll('.club-identity__arena-label')].map(
      (n) => n.textContent ?? ''
    );
    expect(labels).toEqual(['ACTIVE', 'FREEROLL']);
    for (const label of labels) {
      expect(label.length, `${label} is too long for the rail`).toBeLessThanOrEqual(8);
    }
  });

  /* The rail is opaque because what it retires is paint. A transparent
     background would print ACTIVE on top of PLAYING NOW. */
  it('paints an opaque ground under the rail', () => {
    const css = readFileSync(
      join(__dirname, '..', '..', 'src/components/club-buttons/ClubIdentityCard.css'),
      'utf8'
    );
    const rule = css.match(/\.club-identity__arena\s*\{([^}]*)\}/);
    expect(rule, 'the rail has no rule at all').not.toBeNull();
    expect(rule![1]).toMatch(/background:\s*#[0-9a-f]{6}\s*;/i);
    expect(rule![1]).not.toMatch(/transparent|rgba\([^)]*,\s*0?\.\d+\s*\)/i);
  });
});

describe('The freeroll clock', () => {
  it('prints M:SS under an hour, H:MM:SS under a day, and days beyond', () => {
    expect(formatFreerollCountdown(0)).toBe('0:00');
    expect(formatFreerollCountdown(59)).toBe('0:59');
    expect(formatFreerollCountdown(271)).toBe('4:31');
    expect(formatFreerollCountdown(3_661)).toBe('1:01:01');
    expect(formatFreerollCountdown(180_000)).toBe('2d 2h');
  });
});
