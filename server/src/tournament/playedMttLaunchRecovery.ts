/** Validate the existing database proof before proposing a recorded launch. */
export function readPlayedMttLaunchProof(raw: unknown, firstHandAt: string): void {
  const p = raw as Record<string, unknown> | null;
  const count = (value: unknown, minimum: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
  if (
    !p ||
    p.ok !== true ||
    p.first_hand_at !== firstHandAt ||
    !Number.isFinite(Date.parse(firstHandAt)) ||
    !count(p.hands_dealt, 1) ||
    !count(p.playing, 1) ||
    !count(p.eliminated, 0) ||
    !count(p.dealt_field, 3) ||
    p.required_players !== 3 ||
    p.dealt_field !== Number(p.playing) + Number(p.eliminated)
  )
    throw new Error('Database did not prove the exact played MTT field');
}
