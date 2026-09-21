/* The words an owner reaches for when looking for the leaderboard prize
   tools. Lower case because the query is lower-cased before matching. */
export const REWARD_TOOL_SEARCH_WORDS = [
  'leaderboard',
  'leaderboards',
  'prize',
  'prizes',
  'setup',
  'set',
  'up',
  'owner',
  'rewards',
  'reward',
  'promo',
  'wallet',
  'program',
  'plan',
] as const;

/**
 * True when the drawer search should keep the Owner Prize Tools section.
 *
 * Every typed word has to start one of the vocabulary words, in any order, so
 * type-ahead works ("lead", "prizes", "set up", "promo wallet") while a stray
 * fragment ("a", "ward", "romo") does not reveal the tools. An empty query
 * shows them.
 */
export function rewardToolMatchesSearch(query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((word) => REWARD_TOOL_SEARCH_WORDS.some((term) => term.startsWith(word)));
}
