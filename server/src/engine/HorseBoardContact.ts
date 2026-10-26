/** Whether the completed public board supplies the entire best-five hand.
 * Scores include kickers; equal categories alone do not establish this.
 * Kept pure so historical policy-isolation tests can retain their old model
 * without adding an opt-out to production evaluation or rewriting the corpus.
 */
export function isBoardOnlyRiverHand(
  boardLength: number,
  handScore: number,
  boardScore: number
): boolean {
  return boardLength === 5 && handScore === boardScore;
}
