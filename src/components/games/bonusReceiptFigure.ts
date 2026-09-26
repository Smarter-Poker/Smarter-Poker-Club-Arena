import { multiplierLabel } from '../../utils/diamondGamesFairness';

/** The four Diamond bonus games, by the name their routes and awards use. */
export type BonusReceiptGame = 'crash' | 'plinko' | 'crossing' | 'mines';

/** The most a Crash round can book, and the round that gets the crown. */
export const CRASH_MAX_MULTIPLIER = 25;

/**
 * The headline a receipt prints over its game's art: the booked multiplier for
 * Crash, the street reached for Donkey Cross, the winning bucket's multiplier
 * for Plinko and the gems found for Mines. A missing or unreadable figure
 * prints nothing, and the art still stands.
 */
export function receiptFigure(game: BonusReceiptGame, figure: number | null | undefined) {
  const value = Number(figure);
  if (figure === null || figure === undefined || !Number.isFinite(value) || value < 0) return null;
  if (game === 'crash') return `${value.toFixed(2)}x`;
  if (game === 'plinko') return multiplierLabel(Math.round(value * 100));
  if (game === 'crossing') return `Street ${Math.round(value)}`;
  return Math.round(value).toLocaleString('en-US');
}

/**
 * The Plinko bucket's own tint, for the receipt's plate: the board's cool-to-hot
 * schema ramp (navy, royal blue, light blue, chrome white, gold) on the same
 * logarithmic heat, read straight off the multiplier.
 *
 * A mirror of `bucketTint` in src/components/plinko/PlinkoBoard.tsx, kept here
 * so the receipt does not load the WebGL board (and so the page suites that
 * stand the board in with a mock keep working). BonusCompletionArt.test.tsx
 * holds the two equal across the whole range; change them together.
 */
const TINT_RAMP: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0x1c, 0x3d, 0x74],
  [0.25, 0x18, 0x77, 0xf2],
  [0.48, 0x45, 0xad, 0xff],
  [0.64, 0x9f, 0xd3, 0xff],
  [0.78, 0xe4, 0xe7, 0xec],
  [0.9, 0xff, 0xd7, 0x00],
  [1, 0xff, 0xb3, 0x00],
];
const HEAT_FLOOR_CENTS = 5;
const HEAT_CEILING_CENTS = 2500;
const channel = (value: number) =>
  Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, '0');
export function receiptBucketTint(multiplierCents: number): string {
  const cents = Number.isFinite(multiplierCents) ? multiplierCents : 0;
  const heat =
    cents <= HEAT_FLOOR_CENTS
      ? 0
      : cents >= HEAT_CEILING_CENTS
        ? 1
        : Math.log(cents / HEAT_FLOOR_CENTS) / Math.log(HEAT_CEILING_CENTS / HEAT_FLOOR_CENTS);
  let lower = TINT_RAMP[0];
  let upper = TINT_RAMP[TINT_RAMP.length - 1];
  for (let i = 1; i < TINT_RAMP.length; i++) {
    if (heat <= TINT_RAMP[i][0]) {
      lower = TINT_RAMP[i - 1];
      upper = TINT_RAMP[i];
      break;
    }
  }
  const span = upper[0] - lower[0];
  const t = span <= 0 ? 0 : (heat - lower[0]) / span;
  return `#${channel(lower[1] + (upper[1] - lower[1]) * t)}${channel(
    lower[2] + (upper[2] - lower[2]) * t
  )}${channel(lower[3] + (upper[3] - lower[3]) * t)}`;
}
