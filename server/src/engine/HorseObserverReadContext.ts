import type { LiveHorseDecisionSnapshot } from './horseDecision/protocol.js';
const VARIANTS = [
  'nlh',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flh',
  'flo8',
  'short_deck',
  'pineapple',
] as const;
type ObserverVariant = (typeof VARIANTS)[number];
const memoryVariant = (value: unknown): ObserverVariant | null =>
  typeof value === 'string' && VARIANTS.includes(value as ObserverVariant)
    ? (value as ObserverVariant)
    : null;

/** An individual observer's public-read partition. Unknown stays unavailable. */
export interface HorseObserverReadContext {
  readonly version: 1;
  readonly observerId: string;
  readonly variant: ObserverVariant;
  readonly format: 'cash' | 'mtt' | 'sng' | 'spin' | 'hu_sng';
  readonly dealtCount: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function horseObserverReadContextIsValid(value: unknown): value is HorseObserverReadContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ['version', 'observerId', 'variant', 'format', 'dealtCount'];
  return (
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k)) &&
    v.version === 1 &&
    typeof v.observerId === 'string' &&
    UUID.test(v.observerId) &&
    typeof v.variant === 'string' &&
    memoryVariant(v.variant) === v.variant &&
    ['cash', 'mtt', 'sng', 'spin', 'hu_sng'].includes(v.format as string) &&
    Number.isInteger(v.dealtCount) &&
    (v.dealtCount as number) >= 2 &&
    (v.dealtCount as number) <= 10
  );
}
export function horseObserverReadContextKey(value: unknown): string | null {
  if (!horseObserverReadContextIsValid(value)) return null;
  return JSON.stringify([
    value.version,
    value.observerId.toLowerCase(),
    value.variant,
    value.format,
    value.dealtCount,
  ]);
}
export function horseObserverReadContextFromRequest(
  request: Pick<LiveHorseDecisionSnapshot, 'player' | 'gameState'>
): HorseObserverReadContext | null {
  const { gameState: gs, player } = request;
  const variant = memoryVariant(gs.gameVariant);
  const dealt = gs.dealtSeatIds;
  // The original producer's dealt seats are required. RLS chairs and showdown
  // cards do not reconstruct participation. Never infer format from stack size.
  if (
    !variant ||
    // Incomplete tournament context can carry the transport's MTT fallback.
    // It cannot attest an exact MTT/SNG/Spin read partition.
    (gs.gameMode === 'tournament' && gs.tournament?.contextStatus !== 'complete') ||
    !Array.isArray(gs.players) ||
    !Array.isArray(dealt) ||
    new Set(dealt).size !== dealt.length ||
    !dealt.includes(player.seat) ||
    dealt.some((seat) => !Number.isInteger(seat) || seat < 1 || seat > 10) ||
    gs.players.filter((p) => p.user_id === player.user_id && p.seat === player.seat).length !== 1 ||
    dealt.some((seat) => gs.players.filter((p) => p.seat === seat).length !== 1) ||
    (gs.format === 'cash' ? gs.gameMode !== 'cash' : gs.gameMode !== 'tournament')
  )
    return null;
  const value = {
    version: 1,
    observerId: player.user_id?.toLowerCase(),
    variant,
    format: gs.format,
    dealtCount: dealt.length,
  };
  return horseObserverReadContextIsValid(value) ? Object.freeze(value) : null;
}
