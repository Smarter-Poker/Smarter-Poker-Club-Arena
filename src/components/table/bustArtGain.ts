/**
 * GENERATED FILE - do not edit by hand.
 * Regenerate with:  python3 scripts/measure-bust-art.py
 *
 * Per-character size correction for free-floating bust avatars.
 *
 * Every asset is a 125x170 canvas but the character inside it is not drawn to
 * a common scale - measured across the shipped library the subject occupies
 * anywhere from 64% to 100% of canvas height. `object-fit: contain` fits
 * the CANVAS, so an artist's headroom renders as empty pixels and the character
 * reads small through no fault of the CSS.
 *
 * This map corrects for exactly that, and nothing else:
 *
 *     gain = 84.4% (library median) / this character's subject share
 *
 * A character drawn at the median gets 1.0 and is untouched. It is a
 * MULTIPLIER on the global `--sp-bust-scale`, so breakpoints, the top-rail
 * cap and the hover state keep owning everything else.
 *
 * Hand-typing these was the 2026-08-23 bug: `viking: 2` was written from a
 * four-character sample, but the viking is the 6th largest asset of 100 and
 * rendered at 2.9x, spilling off its seat onto the felt. Measurement replaced
 * the guess.
 */
export const BUST_ART_GAIN: Readonly<Record<string, number>> = {
  alien: 0.844,
  alien_overlord: 0.886,
  android: 1.248,
  angel: 1.186,
  arctic_explorer: 1.27,
  artist: 0.957,
  astronaut: 1.196,
  aztec: 0.849,
  aztec_warrior: 1.079,
  badger: 0.92,
  basketball: 1.087,
  bear: 1.167,
  bounty_hunter: 1.248,
  boxer: 0.849,
  bull: 0.897,
  business: 0.844,
  business_cat: 0.844,
  casino_dealer: 0.908,
  chef: 1.186,
  country: 1.226,
  cowboy: 1.104,
  cyber_assassin: 1.071,
  cyber_punk: 0.844,
  cyborg: 0.963,
  dancer: 0.844,
  detective: 0.926,
  director: 1.079,
  dj: 1.025,
  dragon: 1.121,
  eagle: 0.864,
  elite_cyborg: 0.944,
  fire_demon: 0.938,
  football: 0.903,
  fox: 0.908,
  galactic_emperor: 1.226,
  geisha: 0.844,
  geisha_master: 0.849,
  gladiator: 1.176,
  gorilla: 0.938,
  grumpy_cat: 0.914,
  hacker: 0.95,
  hollywood: 0.844,
  ice_queen: 0.849,
  jazz: 0.844,
  knight: 0.95,
  liberty: 0.844,
  lion: 0.864,
  luchador: 1.281,
  mad_scientist: 1.003,
  mecha_pilot: 0.944,
  mobster: 1.104,
  monarch: 1.003,
  mummy: 0.844,
  musician: 1.112,
  neon_ninja: 1.13,
  ninja: 1.206,
  owl: 1.003,
  panther: 1.032,
  penguin: 1.196,
  phantom: 1.003,
  pharaoh: 0.957,
  phoenix: 0.844,
  physicist: 0.844,
  pirate: 0.944,
  plague_doctor: 1.011,
  politician: 0.908,
  pug: 0.92,
  rapper: 1.196,
  rock_legend: 0.99,
  rockstar: 0.875,
  royal_guard: 1.139,
  samurai: 1.27,
  samurai_cyborg: 1.206,
  secret_agent: 0.859,
  shark: 1.248,
  shiba: 0.844,
  silent_actor: 0.844,
  soccer: 0.983,
  sorceress: 1.04,
  space_commander: 1.226,
  space_pioneer: 1.186,
  space_pirate: 1.157,
  space_ranger: 1.071,
  spartan: 1.104,
  steampunk_inventor: 1.003,
  street_racer: 1.139,
  teacher: 0.87,
  tech_mogul: 0.99,
  tiger_boss: 1.27,
  unicorn: 0.997,
  vampire: 1.079,
  vampire_hunter: 1.003,
  vigilante: 1.317,
  viking: 0.891,
  viking_warrior: 0.844,
  voodoo_priest: 1.226,
  wizard: 0.95,
  wolf: 1.04,
  wrestler: 1.167,
  yakuza: 1.226,
};

/**
 * Size correction for the bust art at `avatarUrl`, or 1 when the URL is not a
 * known library bust (uploaded photos, generated SVG monograms, new art that
 * has not been measured yet). 1 means 'render at the global scale', which is
 * the correct and safe default for anything unmeasured.
 */
export function bustArtGain(avatarUrl: string | null | undefined): number {
  if (!avatarUrl) return 1;
  const m = /\/avatars\/table\/(?:free|vip)_([\w-]+?)(?:@2x)?\.webp/.exec(avatarUrl);
  return (m && BUST_ART_GAIN[m[1]]) || 1;
}
