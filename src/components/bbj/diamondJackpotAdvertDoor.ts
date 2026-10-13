/** Only the current Diamond lobby's exact advert destination owns its modal. */
export function isDiamondJackpotAdvertTarget(
  path: string,
  automaticArena: boolean,
  clubKeys: readonly (string | null | undefined)[]
): boolean {
  return automaticArena && clubKeys.some((key) => Boolean(key) && path === `/clubs/${key}/jackpot`);
}
