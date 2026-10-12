import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GAMEPLAY_CERTIFICATE_BOARD } from '../e2e/support/gameplayCertificateBoard';
import { CardImage } from '../../src/components/table/CardImage';
import { mapEngineSnapshot } from '../../src/utils/mapEngineSnapshot';

describe('the routed gameplay certificate uses real engine cards', () => {
  it('maps its original ace, king and seven into readable changing face-deck renders', () => {
    const state = mapEngineSnapshot(
      {
        table_id: 'certificate',
        hand_number: 7,
        stage: 'flop',
        pot: 3,
        current_bet: 2,
        dealer_seat: 2,
        players: [],
        community_cards: GAMEPLAY_CERTIFICATE_BOARD,
      } as Parameters<typeof mapEngineSnapshot>[0],
      'hero',
      6
    );
    expect(state.communityCards).toEqual([
      { rank: 'A', suit: 's' },
      { rank: 'K', suit: 'd' },
      { rank: '7', suit: 'h' },
    ]);
    const view = render(
      <>
        {GAMEPLAY_CERTIFICATE_BOARD.map((card) => (
          <CardImage key={card.rank} card={card} faceDeckId="broadcast-pro" />
        ))}
      </>
    );
    expect(view.container.querySelectorAll('.card-image--unreadable')).toHaveLength(0);
    expect(view.container.querySelectorAll('[data-face-deck="broadcast-pro"]')).toHaveLength(3);
    expect(view.container.querySelectorAll('.card-image__img')).toHaveLength(3);
  });
});
