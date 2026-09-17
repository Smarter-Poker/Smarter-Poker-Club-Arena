/** Creation-time validation. Existing funded ladders keep their recorded terms. */
export function validateMttBlindStructure(raw: unknown, startingStack: unknown): void {
  const number = (value: unknown): number => {
    if (typeof value !== 'number' && typeof value !== 'string') return NaN;
    if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return NaN;
    const n = Number(value);
    return Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER ? n : NaN;
  };
  const fail = (detail: string): never => {
    throw new Error(`Invalid tournament blind structure: ${detail}`);
  };
  const stack = number(startingStack);
  if (!Number.isSafeInteger(stack) || stack <= 0)
    fail('starting stack must be a positive whole number');
  if (!Array.isArray(raw) || raw.length === 0) fail('at least one playable level is required');
  let previousSmall = -1;
  let previousBig = -1;
  let playable = 0;
  for (const [index, entry] of (raw as unknown[]).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      fail(`level ${index + 1} must be an object`);
    const level = entry as Record<string, unknown>;
    if (level.isBreak !== undefined && typeof level.isBreak !== 'boolean')
      fail(`level ${index + 1} has an invalid break flag`);
    const minutes = number(level.durationMinutes ?? level.duration_minutes);
    const seconds = number(level.duration);
    if (!(minutes > 0) && !(seconds > 0)) fail(`level ${index + 1} needs a positive duration`);
    const small = number(level.smallBlind);
    const big = number(level.bigBlind);
    const ante = level.ante === undefined ? 0 : number(level.ante);
    if (
      !Number.isFinite(small) ||
      !Number.isFinite(big) ||
      !Number.isFinite(ante) ||
      small < 0 ||
      ante < 0
    )
      fail(`level ${index + 1} has invalid blinds or ante`);
    if (level.isBreak === true) {
      if (index === 0 || small !== 0 || big !== 0 || ante !== 0)
        fail(`level ${index + 1} is not a valid break`);
      continue;
    }
    if (big <= 0 || small > big)
      fail(`level ${index + 1} needs a positive big blind at least as large as its small blind`);
    if (small < previousSmall || big < previousBig) fail(`level ${index + 1} decreases the blinds`);
    previousSmall = small;
    previousBig = big;
    playable++;
  }
  if (playable === 0) fail('at least one playable level is required');
}
