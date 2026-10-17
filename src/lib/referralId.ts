/**
 * A player's referral ID.
 *
 * Dan (KingFish, player 1), 2026-10-16: "change my referral ID from 1 to
 * KingFish, im the only one that should have there reference ID as a name,
 * everyone else uses player number."
 *
 * So the referral ID is the player number for everyone except player 1,
 * whose referral ID is "KingFish". The name is matched case-insensitively
 * when it comes back in (a typed code, a ?ref= link), and the database door
 * every referral goes through, fn_redeem_club_invite_code, maps it to player
 * number 1 the same way (20261016232523_kingfish_referral_id_resolves_to_player_one).
 * Keep the two in step: one name, one player, nobody else.
 */

const NAMED_REFERRAL_IDS: Readonly<Record<string, string>> = {
  '1': 'KingFish',
};

/** The referral ID to print, copy and put in a link for this player number. */
export function referralIdFor(playerNumber: string | number | null | undefined): string | null {
  if (playerNumber === null || playerNumber === undefined) return null;
  const key = String(playerNumber).trim();
  if (key === '') return null;
  return NAMED_REFERRAL_IDS[key] ?? key;
}

/** The player number a typed or linked referral ID stands for. A number (or
 *  anything that is not a named ID) comes back unchanged. */
export function playerNumberForReferralId(code: string): string {
  const trimmed = code.trim();
  const lower = trimmed.toLowerCase();
  for (const [playerNumber, name] of Object.entries(NAMED_REFERRAL_IDS)) {
    if (name.toLowerCase() === lower) return playerNumber;
  }
  return trimmed;
}

/** True when this referral ID is a name rather than a player number. */
export function isNamedReferralId(referralId: string | null | undefined): boolean {
  if (!referralId) return false;
  const lower = referralId.trim().toLowerCase();
  return Object.values(NAMED_REFERRAL_IDS).some((name) => name.toLowerCase() === lower);
}
