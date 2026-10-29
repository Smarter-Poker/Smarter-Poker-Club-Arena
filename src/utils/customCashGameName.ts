/** Preserve the host name while omitting only generated game/stakes/style labels. */
export function customCashGameName(name: string | null | undefined): string | null {
  if (!name?.trim() || name === 'Loading...') return null;
  const variant =
    /^\s*(nlhe?|no[\s-]?limit[\s-]?hold(?:'|’)?em|plo[4568]?|pot[\s-]?limit[\s-]?omaha|flh|flo8?|limit[_\s-]?(?:holdem|omaha)|pineapple|short[\s_-]?deck|6\+)(?!\w)/i;
  const stakes = /^\s*\$?(?:\d+(?:\.\d+)?|\.\d+)\s*\/\s*\$?(?:\d+(?:\.\d+)?|\.\d+)/;
  const residual = name
    .trim()
    .replace(variant, '')
    .replace(stakes, '')
    .replace(variant, '')
    .replace(stakes, '')
    .replace(/^[\s\-\u2013\u2014:|,]+/, '')
    .trim();
  if (
    !residual ||
    /^(?:(?:Classic|Action|Madness|Lightning(?: Games)?)(?:\s*[-:|,]\s*|\s+))?(?:Main(?:\s+\d+)?|Feeder(?:\s+\d+)?)$/i.test(
      residual
    ) ||
    /^(?:Classic|Action|Madness|Lightning(?: Games)?)$/i.test(residual)
  )
    return null;
  return residual;
}
