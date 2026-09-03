/**
 * HOUSE RULE (Dan 2026-08-26, verbatim): "MAKE SURE ON ALL DISPLAYS THE
 * FIRST LETTER OF EVERY WORD IS CAPITALIZED ... or any other forward facing
 * announcements."
 *
 * The Toast layer already enforces this centrally (popupStyle, 2026-08-20).
 * The RIT surfaces added in the parity work BYPASS the Toast layer — the
 * felt status strip, the consent panel, and the winner ribbons — so each of
 * them must route through the SAME transform. These pins hold that wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { render } from '@testing-library/react';
import { CommunityCards } from '../../src/components/table/CommunityCards';
import { RunItTwicePrompt } from '../../src/components/table/RunItTwice';
import { formatPopupText } from '../../src/utils/popupStyle';
import type { Card } from '../../src/components/table/CardImage';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('every forward-facing RIT display is Title Case', () => {
  it('the winner ribbon renders "Three Of A Kind" for the evaluator\'s "Three of a Kind"', () => {
    const cards: Card[] = [
      { rank: 'T', suit: 'h' },
      { rank: '5', suit: 's' },
      { rank: '9', suit: 'd' },
      { rank: 'Q', suit: 's' },
      { rank: 'J', suit: 'd' },
    ];
    const { container } = render(
      <CommunityCards
        cards={cards}
        stage="river"
        winningHandName="Three of a Kind"
        winningHandDescription="Jacks with a queen kicker"
        deckStyle="4color"
      />
    );
    expect(container.textContent).toContain('Three Of A Kind');
    expect(container.textContent).not.toContain('Three of a Kind');
    expect(container.textContent).toContain('Jacks With A Queen Kicker');
  });

  it('the consent panel message capitalizes every word, keeping name capitals', () => {
    const { container } = render(
      <RunItTwicePrompt
        isOpen={true}
        isChooser={false}
        onAccept={() => {}}
        onDecline={() => {}}
        timeRemaining={20}
        chosenRuns={2}
        opponentName="CataliNO"
      />
    );
    expect(container.textContent).toContain('CataliNO Requests To Run It Twice.');
  });

  it('the felt status strip routes through the central transform', () => {
    // The strip bypasses the Toast layer; the choke point every banner text
    // flows through must apply formatPopupText itself.
    const page = read('src/pages/TablePage.tsx');
    const chokeAt = page.indexOf('setRitFeltBanner(formatPopupText(text))');
    expect(chokeAt, 'showRitFeltBanner must apply formatPopupText').toBeGreaterThan(0);
  });

  it('the transform itself preserves interior capitals in player names', () => {
    expect(formatPopupText('CataliNO has accepted running multi-times.')).toBe(
      'CataliNO Has Accepted Running Multi-Times.'
    );
    expect(formatPopupText('running it once. not everyone agreed in time.')).toBe(
      'Running It Once. Not Everyone Agreed In Time.'
    );
  });
});
