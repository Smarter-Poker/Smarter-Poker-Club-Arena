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
 *     gain = 88.8% (library median) / this character's subject share
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
  alien: 0.888,
  alien_overlord: 0.932,
  android: 1.313,
  angel: 1.248,
  arctic_explorer: 1.336,
  artist: 0.91,
  astronaut: 1.258,
  aztec: 0.893,
  aztec_warrior: 1.135,
  badger: 0.968,
  basketball: 0.932,
  bear: 0.921,
  bounty_hunter: 1.313,
  boxer: 0.91,
  bull: 0.904,
  business: 0.888,
  business_cat: 0.944,
  casino_dealer: 0.956,
  chef: 1.248,
  country: 1.291,
  cowboy: 1.162,
  cyber_assassin: 1.127,
  cyber_punk: 0.888,
  cyborg: 1.013,
  dancer: 0.915,
  detective: 0.974,
  director: 1.135,
  dj: 1.079,
  dragon: 0.899,
  eagle: 0.91,
  elite_cyborg: 0.993,
  fire_demon: 0.987,
  football: 0.91,
  fox: 0.956,
  galactic_emperor: 1.291,
  geisha: 0.888,
  geisha_master: 0.893,
  gladiator: 1.238,
  gorilla: 0.987,
  grumpy_cat: 1.013,
  hacker: 1.0,
  hollywood: 0.888,
  ice_queen: 0.893,
  jazz: 0.888,
  knight: 1.0,
  liberty: 0.915,
  lion: 0.91,
  luchador: 1.348,
  mad_scientist: 1.056,
  mecha_pilot: 0.993,
  mobster: 1.162,
  monarch: 1.056,
  mummy: 0.888,
  musician: 1.171,
  neon_ninja: 1.189,
  ninja: 1.269,
  owl: 1.056,
  panther: 0.926,
  penguin: 1.258,
  phantom: 1.056,
  pharaoh: 0.926,
  phoenix: 0.888,
  physicist: 0.899,
  pirate: 0.993,
  plague_doctor: 1.063,
  politician: 0.956,
  pug: 0.921,
  rapper: 0.904,
  rock_legend: 1.041,
  rockstar: 0.921,
  royal_guard: 1.198,
  samurai: 1.336,
  samurai_cyborg: 1.269,
  secret_agent: 0.921,
  shark: 1.313,
  shiba: 0.888,
  silent_actor: 0.888,
  soccer: 0.915,
  sorceress: 1.094,
  space_commander: 1.291,
  space_pioneer: 1.248,
  space_pirate: 1.218,
  space_ranger: 1.127,
  spartan: 1.162,
  steampunk_inventor: 1.056,
  street_racer: 1.198,
  teacher: 0.915,
  tech_mogul: 1.041,
  tiger_boss: 1.336,
  unicorn: 0.888,
  vampire: 1.135,
  vampire_hunter: 1.056,
  vigilante: 1.385,
  viking: 0.938,
  viking_warrior: 0.888,
  voodoo_priest: 1.291,
  wizard: 1.0,
  wolf: 0.915,
  wrestler: 1.228,
  yakuza: 1.291,
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
