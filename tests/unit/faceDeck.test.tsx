import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FACE_DECK_ID,
  FACE_DECK_CATALOG,
  FACE_DECK_IDS,
  applyFaceDeckToDocument,
  faceDeckForThemePreset,
  faceDeckStorefrontFeature,
  normalizeFaceDeckId,
} from '../../src/lib/faceDeck';
import { CARD_BACK_CATALOG, CardBack, CardImage } from '../../src/components/table/CardImage';

describe('face-deck catalog', () => {
  it('ships the exact ten ids, prices, and free default in display order', () => {
    expect(FACE_DECK_CATALOG.map(({ id, price }) => [id, price])).toEqual([
      ['house-classic', 0],
      ['broadcast-pro', 0],
      ['ivory-club', 0],
      ['midnight-foil', 75],
      ['carbon-edge', 75],
      ['royal-purple', 100],
      ['emerald-room', 100],
      ['crimson-signature', 125],
      ['platinum-line', 175],
      ['neon-circuit', 200],
    ]);
    expect(FACE_DECK_CATALOG).toHaveLength(10);
    expect(FACE_DECK_CATALOG.filter(({ tier }) => tier === 'free')).toHaveLength(3);
    expect(DEFAULT_FACE_DECK_ID).toBe('house-classic');
    expect(FACE_DECK_IDS).toEqual(FACE_DECK_CATALOG.map(({ id }) => id));
  });

  it('normalizes legacy/unknown values and uses the exact storefront category', () => {
    expect(normalizeFaceDeckId(undefined)).toBe('house-classic');
    expect(normalizeFaceDeckId('not-a-card-design')).toBe('house-classic');
    expect(normalizeFaceDeckId('neon-circuit')).toBe('neon-circuit');
    expect(faceDeckStorefrontFeature('midnight-foil')).toBe('studio:face_deck_id:midnight-foil');
  });

  it('maps every coordinated preset to one real face deck', () => {
    for (const preset of [
      'default-dark',
      'classic-brown',
      'ocean-depths',
      'neon-blue',
      'rustic-wood',
      'casino-green',
      'crimson-club',
      'arctic-suite',
      'amethyst-night',
      'carbon-ion',
    ]) {
      expect(FACE_DECK_IDS).toContain(faceDeckForThemePreset(preset));
    }
  });

  it('applies the finish as DOM state without changing rank, suit, or color-deck art', () => {
    const root = document.createElement('section');
    expect(applyFaceDeckToDocument('platinum-line', root)).toBe('platinum-line');
    expect(root).toHaveAttribute('data-face-deck', 'platinum-line');

    const view = render(
      <>
        <CardImage card={{ rank: 'A', suit: 's' }} deckStyle="4color" faceDeckId="house-classic" />
        <CardImage card={{ rank: 'A', suit: 's' }} deckStyle="4color" faceDeckId="neon-circuit" />
      </>
    );
    const cards = view.container.querySelectorAll<HTMLElement>('.card-image');
    const images = view.container.querySelectorAll<HTMLImageElement>('.card-image__img');

    expect(cards[0]).toHaveAttribute('data-face-deck', 'house-classic');
    expect(cards[1]).toHaveAttribute('data-face-deck', 'neon-circuit');
    expect(images[0].getAttribute('src')).toBe(images[1].getAttribute('src'));
    expect(images[0].getAttribute('src')).toContain('/cards/4color/spades_a.webp');
  });

  it('keeps the twelve-card-back product separate from face-deck finishes', () => {
    const view = render(
      <section data-face-deck="neon-circuit">
        <CardBack style="classic_red" size="sm" />
      </section>
    );
    const back = view.container.querySelector<HTMLElement>('.card-image--back');

    expect(CARD_BACK_CATALOG).toHaveLength(12);
    expect(back).toBeInTheDocument();
    expect(back).not.toHaveAttribute('data-face-deck');
  });
});
