import { hmacSha256Hex } from './wheelFairness';
import { roundedMinePrize } from './diamondChoiceMath';

/** Uses the same independent cent draw as server settlement. */
export async function sealedChipPrize(input: {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  betChips: number;
  multiplierCents: number;
  roundingStep: number;
}) {
  if (
    !Number.isFinite(input.betChips) ||
    input.betChips <= 0 ||
    !Number.isSafeInteger(input.multiplierCents) ||
    input.multiplierCents < 0 ||
    !Number.isSafeInteger(input.roundingStep) ||
    input.roundingStep < 1
  ) {
    throw new Error('The Sealed Prize Could Not Be Checked');
  }
  const hash = await hmacSha256Hex(
    input.serverSeed,
    `${input.clientSeed}:${input.nonce}:rounding:${input.roundingStep}`
  );
  return (
    Number(
      roundedMinePrize(
        BigInt(Math.round(input.betChips * 100)) * BigInt(input.multiplierCents),
        100n,
        BigInt(`0x${hash.slice(0, 12)}`)
      )
    ) / 100
  );
}
