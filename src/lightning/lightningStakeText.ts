import { stakesLabel } from '../lib/bettingStructure';

/** Names and remembered labels use the same stakes notation as the live table. */
export function lightningStakeText(text: string): string {
  return text.replace(
    /\b(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\b/g,
    (_match, small: string, big: string) => stakesLabel(Number(small), Number(big))
  );
}
