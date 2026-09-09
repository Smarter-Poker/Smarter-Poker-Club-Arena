import type { Card } from '../components/table/CardImage';
import { cardKey } from './handEvaluator';

/** Highlight the evaluator's recorded award, including low halves and side pots. */
export function ritAwardHighlights(
  board: Card[],
  awards: Array<{ userId: string; cards?: Card[] }>,
  players: Array<{ id: string; holeCards?: Array<Card | null> } | null>
): { boardIndices: number[]; holeIndices: Record<string, number[]> } {
  const boardIndices = new Set<number>();
  const holes = new Map<string, Set<number>>();
  for (const award of awards) {
    // Older engines have the award name but no recorded five. No highlight
    // is safer than substituting a high hand for an awarded low hand.
    if (award.cards?.length !== 5) continue;
    const used = new Set(award.cards.map(cardKey));
    board.forEach((card, i) => {
      if (used.has(cardKey(card))) boardIndices.add(i);
    });
    const indices = holes.get(award.userId) ?? new Set<number>();
    const player = players.find((p) => p?.id === award.userId);
    player?.holeCards?.forEach((card, i) => {
      if (card && used.has(cardKey(card))) indices.add(i);
    });
    holes.set(award.userId, indices);
  }
  return {
    boardIndices: [...boardIndices].sort((a, b) => a - b),
    holeIndices: Object.fromEntries(
      [...holes].map(([id, indices]) => [id, [...indices].sort((a, b) => a - b)])
    ),
  };
}
