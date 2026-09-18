import { isThrowableEventId } from '../throwables/identity';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE SERVICE — 49-Item Dynamic Throwables (2026-08-20 rebuild)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style throwables, fully replaced:
 * - 49 3D-rendered items live in the Supabase `images` bucket under `throwables/`
 *   (pure-black backgrounds — rendered with mix-blend-mode: screen so the black
 *   disappears over the arena UI; see ThrowableImage.tsx).
 * - Every item carries its own PHYSICS profile (flight path), IMPACT profile
 *   (what happens on landing), SOUND key (procedural Web Audio recipe in
 *   ThrowableSoundService), weight (screen shake), spin, and splat color.
 * - VIP: 500 free throws per month, then 1 Diamond each.
 * - Lifetime VIP: unlimited throws with no pack-credit or Diamond spend.
 *   Both paths are server-authoritative through fn_use_throwable_v2.
 *
 * Wire format is unchanged: `[THROW:<id>:<seat>]` broadcast over the engine
 * WebSocket chat channel. IDs match the storage filenames exactly
 * (`throwables/<id>.jpg`), so the catalog IS the asset manifest.
 */

import { supabase } from '../lib/supabase';
import { resolveVipStatus } from '../utils/vipStatus';
import stillManifest from '../throwables/stills.generated.json';

const premiumStills: Record<string, Record<string, string>> = stillManifest;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ThrowableCategory = 'reactions' | 'throws' | 'sports' | 'cheers' | 'premium';

/**
 * Flight physics profiles (how the item travels sender → target):
 * - arc      classic parabolic toss with tumble
 * - fastball flat, fast, aggressive line drive
 * - lob      high, slow, dramatic rainbow arc
 * - float    gentle drift with bobbing (emoji reactions)
 * - drop     travels above the target, then slams straight DOWN (anvil!)
 * - swoop    S-curve glide (ufo, ghost, shark)
 * - spiral   corkscrew wobble flight (chicken, football spiral)
 */
export type ThrowPhysics = 'arc' | 'fastball' | 'lob' | 'float' | 'drop' | 'swoop' | 'spiral';

/**
 * Impact profiles (what happens when it lands):
 * - splat    squashes flat, sprays goo particles, leaves a stain
 * - splash   liquid burst, droplet particles, wet sheen stain
 * - bounce   elastic squash-and-stretch rebound, no mess
 * - thud     heavy stop-dead hit, dust ring, shake
 * - explode  flash + fireball + shockwave + scorch mark
 * - shatter  breaks into shard particles
 * - zap      electric flash + jagged spark particles
 * - sparkle  glitter burst (celebratory / reactions)
 * - burst    confetti-pop scatter (cash, champagne, fireworks)
 */
export type ThrowImpact =
  | 'splat'
  | 'splash'
  | 'bounce'
  | 'thud'
  | 'explode'
  | 'shatter'
  | 'zap'
  | 'sparkle'
  | 'burst';

export type ThrowWeight = 'light' | 'medium' | 'heavy';

export interface Throwable {
  id: string; // == storage filename stem (throwables/<id>.jpg)
  name: string;
  category: ThrowableCategory;
  physics: ThrowPhysics;
  impact: ThrowImpact;
  /** Sound recipe key — see ThrowableSoundService.playImpact() */
  sound: string;
  /** heavy ⇒ screen shake on impact */
  weight: ThrowWeight;
  /** Leaves a stain/residue that lingers after impact */
  linger: boolean;
  /** Particle + stain color */
  color: string;
  /** Secondary particle color (defaults to color) */
  color2?: string;
  /** Total tumble rotation during flight, degrees (0 = no spin) */
  spin: number;
}

export interface ThrowEvent {
  id: string;
  fromSeat: number;
  toSeat: number;
  throwableId: string;
  throwable: Throwable;
  timestamp: number;
}

export interface ThrowAllowance {
  isVip: boolean;
  unlimited: boolean;
  unavailable?: boolean;
  freeThrowsRemaining: number;
  /** Club-shop pack credits consumed before a diamond is charged. */
  packThrowsRemaining: number;
  diamondCost: number; // 0 if free throws available, otherwise 1
}

/** Convert database refusal codes into safe player-facing copy. */
export function normalizeThrowableError(value: unknown): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (normalized.includes('insufficient') && normalized.includes('diamond')) {
    return 'Insufficient Diamonds';
  }
  if (normalized.includes('authentication') || normalized.includes('not authenticated')) {
    return 'Authentication Required';
  }
  if (normalized.includes('invalid throwable') || normalized.includes('not found')) {
    return 'Throwable Not Found';
  }
  if (normalized.includes('wait') || normalized.includes('rate limit')) {
    return 'Please Wait Before Sending Another Throwable';
  }
  return 'Could Not Send Reaction';
}

// ═══════════════════════════════════════════════════════════════════════════════
// THROWABLE LIBRARY — 49 items, ids match Supabase storage filenames
// ═══════════════════════════════════════════════════════════════════════════════

const T = (
  id: string,
  name: string,
  category: ThrowableCategory,
  physics: ThrowPhysics,
  impact: ThrowImpact,
  sound: string,
  weight: ThrowWeight,
  linger: boolean,
  color: string,
  spin: number,
  color2?: string
): Throwable => ({
  id,
  name,
  category,
  physics,
  impact,
  sound,
  weight,
  linger,
  color,
  spin,
  color2,
});

const THROWABLES: Throwable[] = [
  T('crown', 'Crown Me', 'cheers', 'fastball', 'thud', 'crown_cue', 'light', false, '#D7AD49', 0),
  T(
    'chip_rain',
    'Chip Rain',
    'cheers',
    'fastball',
    'thud',
    'chip_rain_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'diamond_shower',
    'Diamond Shower',
    'cheers',
    'fastball',
    'thud',
    'diamond_shower_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'velvet_rope',
    'Velvet Rope',
    'cheers',
    'fastball',
    'thud',
    'velvet_rope_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'champagne_tower',
    'Champagne Tower',
    'cheers',
    'fastball',
    'thud',
    'champagne_tower_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'standing_ovation',
    'Standing Ovation',
    'cheers',
    'fastball',
    'thud',
    'standing_ovation_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T('whale', 'Whale', 'cheers', 'fastball', 'thud', 'whale_cue', 'light', false, '#D7AD49', 0),
  T(
    'to_the_moon',
    'To The Moon',
    'cheers',
    'fastball',
    'thud',
    'to_the_moon_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'missile',
    'Missile',
    'premium',
    'fastball',
    'thud',
    'missile_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T('donkey', 'Donkey', 'premium', 'fastball', 'thud', 'donkey_cue', 'light', false, '#D7AD49', 0),
  T(
    'tilt_meter',
    'Tilt Meter',
    'premium',
    'fastball',
    'thud',
    'tilt_meter_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'bad_beat_bandage',
    'Bad Beat Bandage',
    'premium',
    'fastball',
    'thud',
    'bad_beat_bandage_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'bubble_boy',
    'Bubble Boy',
    'premium',
    'fastball',
    'thud',
    'bubble_boy_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'slot_machine',
    'Slot Machine',
    'premium',
    'fastball',
    'thud',
    'slot_machine_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'pumpkin',
    'Pumpkin',
    'premium',
    'fastball',
    'thud',
    'pumpkin_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'snowball',
    'Snowball',
    'premium',
    'fastball',
    'thud',
    'snowball_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'party_popper',
    'Party Popper',
    'premium',
    'fastball',
    'thud',
    'party_popper_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'heart_arrow',
    'Heart Arrow',
    'premium',
    'fastball',
    'thud',
    'heart_arrow_cue',
    'light',
    false,
    '#D7AD49',
    0
  ),
  T(
    'rat_card',
    'Cheating Rat',
    'premium',
    'fastball',
    'thud',
    'card_slap',
    'light',
    false,
    '#929CA8',
    0
  ),
  T(
    'party_face',
    'Party Face',
    'reactions',
    'fastball',
    'burst',
    'party_toot',
    'light',
    false,
    '#E7AF34',
    0
  ),
  T(
    'thinking',
    'Thinking Face',
    'reactions',
    'fastball',
    'thud',
    'thinking_pop',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T(
    'loser_hand',
    'Loser Hand',
    'reactions',
    'fastball',
    'thud',
    'loser_hand_cue',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T('blush', 'Blush', 'reactions', 'fastball', 'thud', 'blush_cue', 'light', false, '#FFD93D', 0),
  T(
    'ok_smug',
    'Smug OK',
    'reactions',
    'fastball',
    'thud',
    'ok_smug_cue',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T(
    'sleeping',
    'Sleeping',
    'reactions',
    'fastball',
    'thud',
    'sleeping_cue',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T(
    'facepalm',
    'Facepalm',
    'reactions',
    'fastball',
    'thud',
    'facepalm_cue',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T(
    'screaming',
    'Screaming',
    'reactions',
    'fastball',
    'thud',
    'screaming_cue',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T(
    'vomit_rainbow',
    'Rainbow Reaction',
    'reactions',
    'fastball',
    'thud',
    'vomit_rainbow_cue',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T(
    'surrender',
    'Surrender',
    'reactions',
    'fastball',
    'thud',
    'surrender_cue',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T(
    'energy_ball',
    'Energy Ball',
    'premium',
    'fastball',
    'thud',
    'energy_ball_cue',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T('sloth', 'Sloth', 'premium', 'fastball', 'thud', 'sloth_cue', 'light', false, '#FFD93D', 0),
  T('fish', 'Fish', 'throws', 'fastball', 'splash', 'fish_flop', 'light', false, '#58BDEB', 0),
  // ── REACTIONS (8) — floaty emoji, sparkle finishes ────────────────────────────
  T(
    'thumbs_up',
    'Thumbs Up',
    'reactions',
    'float',
    'sparkle',
    'pop_up',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T(
    'thumbs_down',
    'Thumbs Down',
    'reactions',
    'float',
    'sparkle',
    'pop_down',
    'light',
    false,
    '#FF6B6B',
    0
  ),
  T(
    'laughing_emoji',
    'LOL',
    'reactions',
    'float',
    'bounce',
    'giggle',
    'light',
    false,
    '#FFD93D',
    0
  ),
  T(
    'crying_emoji',
    'Crying',
    'reactions',
    'float',
    'splash',
    'weep',
    'light',
    false,
    '#6EC6FF',
    0,
    '#B3E5FC'
  ),
  T(
    'angry_emoji',
    'Rage',
    'reactions',
    'fastball',
    'burst',
    'growl',
    'medium',
    false,
    '#FF5252',
    180
  ),
  T(
    'cool_sunglasses_emoji',
    'Too Cool',
    'reactions',
    'float',
    'sparkle',
    'smooth',
    'light',
    false,
    '#40C4FF',
    0
  ),
  T(
    'heart',
    'Heart',
    'reactions',
    'float',
    'sparkle',
    'kiss',
    'light',
    false,
    '#FF4081',
    0,
    '#F8BBD0'
  ),
  T(
    'star',
    'Star',
    'reactions',
    'arc',
    'sparkle',
    'twinkle',
    'light',
    false,
    '#FFD93D',
    360,
    '#FFF59D'
  ),

  // ── THROWS (12) — the messy classics ──────────────────────────────────────────
  T(
    'tomato',
    'Tomato',
    'throws',
    'arc',
    'splat',
    'splat_wet',
    'medium',
    true,
    '#E53935',
    540,
    '#FF8A80'
  ),
  T(
    'cracked_egg',
    'Egg',
    'throws',
    'arc',
    'splat',
    'egg_crack',
    'medium',
    true,
    '#FFF3C4',
    480,
    '#FFC107'
  ),
  T(
    'banana_peel',
    'Banana Peel',
    'throws',
    'lob',
    'bounce',
    'slip',
    'light',
    false,
    '#FFEB3B',
    720
  ),
  T(
    'pizza_slice',
    'Pizza',
    'throws',
    'arc',
    'splat',
    'splat_cheese',
    'medium',
    true,
    '#FF9800',
    540,
    '#FFCC80'
  ),
  T(
    'cake',
    'Cake',
    'throws',
    'lob',
    'splat',
    'splat_heavy',
    'heavy',
    true,
    '#F48FB1',
    360,
    '#FFF9C4'
  ),
  T(
    'poop',
    'Poop',
    'throws',
    'lob',
    'splat',
    'splat_gross',
    'medium',
    true,
    '#795548',
    360,
    '#A1887F'
  ),
  T(
    'water_gun',
    'Water Gun',
    'sports',
    'fastball',
    'splash',
    'squirt',
    'light',
    true,
    '#29B6F6',
    0,
    '#B3E5FC'
  ),
  T(
    'boxing_glove',
    'Boxing Glove',
    'sports',
    'fastball',
    'thud',
    'punch',
    'heavy',
    false,
    '#E53935',
    0
  ),
  T(
    'anvil',
    'Anvil',
    'throws',
    'drop',
    'thud',
    'anvil_clang',
    'heavy',
    true,
    '#78909C',
    0,
    '#B0BEC5'
  ),
  T(
    'trash_can',
    'Trash Can',
    'throws',
    'arc',
    'thud',
    'metal_crash',
    'heavy',
    true,
    '#8D9BA6',
    420,
    '#CFD8DC'
  ),
  T(
    'snowman',
    'Snowman',
    'throws',
    'arc',
    'splat',
    'snow_poof',
    'medium',
    true,
    '#E1F5FE',
    360,
    '#FFFFFF'
  ),
  T(
    'magnet',
    'Magnet',
    'throws',
    'fastball',
    'zap',
    'magnet_clink',
    'medium',
    false,
    '#EF5350',
    360,
    '#90A4AE'
  ),

  // ── SPORTS (7) — bouncers and rollers ─────────────────────────────────────────
  T(
    'basketball',
    'Basketball',
    'sports',
    'arc',
    'bounce',
    'ball_bounce',
    'medium',
    false,
    '#FF7043',
    720
  ),
  T(
    'football',
    'Football',
    'sports',
    'spiral',
    'thud',
    'football_hit',
    'medium',
    false,
    '#8D6E63',
    1080
  ),
  T(
    'tennis_ball',
    'Tennis Ball',
    'sports',
    'fastball',
    'bounce',
    'tennis_pop',
    'light',
    false,
    '#CDDC39',
    900
  ),
  T(
    'bowling_ball',
    'Bowling Ball',
    'sports',
    'lob',
    'thud',
    'bowling_strike',
    'heavy',
    false,
    '#5C6BC0',
    360
  ),
  T(
    'horseshoe',
    'Horseshoe',
    'sports',
    'arc',
    'bounce',
    'lucky_clang',
    'medium',
    false,
    '#B0BEC5',
    720,
    '#FFD93D'
  ),
  T(
    'dice',
    'Dice',
    'sports',
    'arc',
    'bounce',
    'dice_rattle',
    'light',
    false,
    '#FFFFFF',
    1080,
    '#EF5350'
  ),
  T(
    'magic_8_ball',
    'Magic 8-Ball',
    'sports',
    'arc',
    'bounce',
    'mystic',
    'medium',
    false,
    '#7E57C2',
    540,
    '#B39DDB'
  ),

  // ── CHEERS (8) — celebrate (or gloat) ─────────────────────────────────────────
  T(
    'beer',
    'Beer',
    'cheers',
    'arc',
    'splash',
    'glass_fizz',
    'medium',
    true,
    '#FFB300',
    240,
    '#FFF8E1'
  ),
  T(
    'champagne',
    'Champagne',
    'cheers',
    'lob',
    'burst',
    'cork_pop',
    'medium',
    true,
    '#FFD93D',
    240,
    '#FFF9C4'
  ),
  T(
    'coffee',
    'Coffee',
    'cheers',
    'arc',
    'splash',
    'hot_splash',
    'medium',
    true,
    '#6D4C41',
    240,
    '#D7CCC8'
  ),
  T(
    'cash_stack',
    'Cash Stack',
    'cheers',
    'lob',
    'burst',
    'cash_count',
    'medium',
    false,
    '#66BB6A',
    360,
    '#A5D6A7'
  ),
  T(
    'diamond',
    'Diamond',
    'cheers',
    'arc',
    'shatter',
    'crystal_chime',
    'medium',
    false,
    '#4DD0E1',
    540,
    '#E0F7FA'
  ),
  T(
    'rose',
    'Rose',
    'cheers',
    'float',
    'sparkle',
    'romance',
    'light',
    false,
    '#EC407A',
    180,
    '#F8BBD0'
  ),
  T(
    'trophy',
    'Trophy',
    'cheers',
    'lob',
    'sparkle',
    'fanfare',
    'medium',
    false,
    '#FFD93D',
    180,
    '#FFF59D'
  ),
  T(
    'fireworks',
    'Fireworks',
    'cheers',
    'lob',
    'explode',
    'firework',
    'heavy',
    false,
    '#FF4081',
    360,
    '#40C4FF'
  ),

  // ── PREMIUM (14) — the big-ticket chaos ───────────────────────────────────────
  T(
    'bomb',
    'Bomb',
    'premium',
    'lob',
    'explode',
    'bomb_boom',
    'heavy',
    true,
    '#FF7043',
    360,
    '#FFD93D'
  ),
  T(
    'rocket',
    'Rocket',
    'premium',
    'fastball',
    'explode',
    'rocket_boom',
    'heavy',
    true,
    '#FF5252',
    0,
    '#FFD93D'
  ),
  T(
    'ufo',
    'UFO',
    'premium',
    'swoop',
    'zap',
    'ufo_warble',
    'medium',
    false,
    '#69F0AE',
    720,
    '#B9F6CA'
  ),
  T(
    'alien',
    'Alien',
    'premium',
    'swoop',
    'zap',
    'alien_blip',
    'medium',
    false,
    '#76FF03',
    360,
    '#CCFF90'
  ),
  T(
    'robot',
    'Robot',
    'premium',
    'fastball',
    'zap',
    'robo_zap',
    'heavy',
    false,
    '#90A4AE',
    180,
    '#4DD0E1'
  ),
  T(
    'ghost',
    'Ghost',
    'premium',
    'swoop',
    'burst',
    'ghost_woo',
    'light',
    false,
    '#E8EAF6',
    0,
    '#C5CAE9'
  ),
  T(
    'skull',
    'Skull',
    'premium',
    'arc',
    'shatter',
    'doom_rattle',
    'medium',
    false,
    '#ECEFF1',
    540,
    '#B0BEC5'
  ),
  T(
    'lightning_bolt',
    'Lightning',
    'premium',
    'fastball',
    'zap',
    'thunder',
    'heavy',
    false,
    '#FFEE58',
    0,
    '#FFFFFF'
  ),
  T(
    'doge',
    'Doge',
    'premium',
    'arc',
    'bounce',
    'doge_bark',
    'medium',
    false,
    '#D7A86E',
    360,
    '#FFECB3'
  ),
  T('shark', 'Shark', 'premium', 'swoop', 'thud', 'chomp', 'heavy', false, '#546E7A', 0, '#B0BEC5'),
  T(
    'bear',
    'Bear',
    'premium',
    'lob',
    'thud',
    'bear_roar',
    'heavy',
    false,
    '#8D6E63',
    180,
    '#BCAAA4'
  ),
  T(
    'chicken',
    'Chicken',
    'premium',
    'spiral',
    'bounce',
    'cluck',
    'light',
    false,
    '#FFF8E1',
    720,
    '#FF7043'
  ),
  T(
    'rubber_duck',
    'Rubber Duck',
    'premium',
    'lob',
    'bounce',
    'squeak',
    'light',
    false,
    '#FFEB3B',
    360,
    '#FF9800'
  ),
];

// Fast lookup
const THROWABLE_MAP: Map<string, Throwable> = new Map(THROWABLES.map((t) => [t.id, t]));

// ── Legacy ID bridge ─────────────────────────────────────────────────────────
// Old clients broadcast the 25 retired ids over `[THROW:id:seat]` during the
// rollout window. Map them onto the nearest new item so a mixed-version table
// still renders every throw instead of silently dropping it.
const LEGACY_ID_MAP: Record<string, string> = {
  'thumbs-up': 'thumbs_up',
  clap: 'star',
  lol: 'laughing_emoji',
  sad: 'crying_emoji',
  mad: 'angry_emoji',
  tomato: 'tomato',
  egg: 'cracked_egg',
  snowball: 'snowman',
  'water-balloon': 'water_gun',
  pie: 'cake',
  beer: 'beer',
  champagne: 'champagne',
  trophy: 'trophy',
  fireworks: 'fireworks',
  confetti: 'fireworks',
  'good-luck': 'horseshoe',
  'nice-hand': 'thumbs_up',
  fish: 'shark',
  shark: 'shark',
  'all-in': 'cash_stack',
  'diamond-rain': 'diamond',
  dragon: 'bomb',
  lightning: 'lightning_bolt',
  tsunami: 'water_gun',
  crown: 'trophy',
};

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE URLS — Supabase `images` bucket, throwables/<id>.jpg
// ═══════════════════════════════════════════════════════════════════════════════

const imageUrlCache = new Map<string, string>();

/**
 * Raw (full-size) public URL for a throwable's 3D render. The originals are
 * 300-620 KB JPGs — never draw these directly in a 40px tile; they exist as
 * the fallback when the transform endpoint is unavailable.
 */
export function getThrowableRawUrl(id: string): string {
  const premium = premiumStills[id]?.['640'];
  if (premium) return `${import.meta.env.BASE_URL}${premium}`;
  const key = `${id}@raw`;
  const cached = imageUrlCache.get(key);
  if (cached) return cached;
  const { data } = supabase.storage.from('images').getPublicUrl(`throwables/${id}.jpg`);
  const url = data?.publicUrl || '';
  if (url) imageUrlCache.set(key, url);
  return url;
}

/**
 * Sized public URL for a throwable render via the Storage image-transform
 * endpoint (/render/image/), the same pipeline the avatars use (measured
 * there 2026-08-20: a 263 KB original comes back as 3.5 KB at 112px).
 *
 * Without this, the selector grid pulled 49 full-size JPGs — ~22 MB — to
 * paint 40px tiles. Two retina buckets cover every surface we draw:
 *   96px  selector tiles (40-44px boxes)
 *   160px flight + impact (42-76px boxes)
 * resize=contain (NOT the avatars' cover): items must never be cropped.
 */
export function getThrowableImageUrl(id: string, displayPx?: number): string {
  // BOMB POT ART 2026-08-21: a third, larger bucket. The bomb-pot overlay draws
  // the bomb render at ~210px on the felt — at the 160 bucket it visibly
  // softens. 320 measured at 9 KB (vs 3.7 KB at 160), which is nothing for a
  // once-per-bomb-pot hero image, and the cache key is already bucket-aware.
  //
  // SIZE PASS 2026-08-21 (Dan: doubled throw sizes + 3-across selector): the
  // small buckets are now below 1x on retina — selector tiles draw at 84px and
  // impacts at up to 152px. Rebalanced to two buckets that cover 2x for every
  // real call site, keeping 320 as the top so the bomb-pot hero is unaffected:
  //   <=96px  -> 192  (selector tiles at 84)
  //   >96px   -> 320  (flight 84-116, impact 112-152, bomb-pot hero ~210)
  const bucket = displayPx !== undefined && displayPx <= 96 ? 192 : 320;
  const premium = premiumStills[id]?.[String(bucket)];
  if (premium) return `${import.meta.env.BASE_URL}${premium}`;
  const key = `${id}@${bucket}`;
  const cached = imageUrlCache.get(key);
  if (cached) return cached;
  const raw = getThrowableRawUrl(id);
  if (!raw) return '';
  let url = raw;
  if (raw.includes('/storage/v1/object/public/')) {
    url =
      raw.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') +
      `?width=${bucket}&height=${bucket}&resize=contain&quality=80`;
  }
  imageUrlCache.set(key, url);
  return url;
}

const VIP_FREE_THROWS_PER_MONTH = 500;
const MEMBER_FREE_THROWS_PER_MONTH = 30;
const DIAMOND_COST_PER_THROW = 1;

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class ThrowableServiceClass {
  private pendingUses = new Map<string, string>();

  /** Keep an uncertain charge's identity across retries and panel remounts. */
  private useRequest(key: string): string {
    const pending = this.pendingUses.get(key);
    if (pending) return pending;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(key);
    } catch {
      // Storage can be disabled; the in-memory identity still protects retries.
    }
    const id =
      saved && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved)
        ? saved
        : crypto.randomUUID();
    this.pendingUses.set(key, id);
    try {
      sessionStorage.setItem(key, id);
    } catch {
      // Best effort persistence; never make storage access a payment dependency.
    }
    return id;
  }

  private finishUse(key: string, id: string): void {
    if (this.pendingUses.get(key) !== id) return;
    this.pendingUses.delete(key);
    try {
      if (sessionStorage.getItem(key) === id) sessionStorage.removeItem(key);
    } catch {
      // In-memory state has already been released.
    }
  }

  /** All current catalogue entries. */
  getThrowables(): Throwable[] {
    return THROWABLES;
  }

  /**
   * Grouped by category. Dan 2026-08-21: tab order is
   * VIP / Toys / Sports / Party / Emoji. VIP leads because it is the tab that
   * sells something; Emoji trails because it is the least interesting thing to
   * throw. Insertion order here IS the tab order — the selector maps over
   * Object.keys of this shape.
   */
  getThrowablesByCategory(): Record<ThrowableCategory, Throwable[]> {
    return {
      premium: THROWABLES.filter((t) => t.category === 'premium'),
      throws: THROWABLES.filter((t) => t.category === 'throws'),
      sports: THROWABLES.filter((t) => t.category === 'sports'),
      cheers: THROWABLES.filter((t) => t.category === 'cheers'),
      reactions: THROWABLES.filter((t) => t.category === 'reactions'),
    };
  }

  /** Check the current server-backed throw entitlement. */
  async getThrowAllowance(userId: string): Promise<ThrowAllowance> {
    try {
      const [profileResult, packResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('is_vip, vip_tier, vip_expires_at')
          .eq('id', userId)
          .maybeSingle(),
        supabase
          .from('feature_purchases')
          .select('uses_remaining, expires_at')
          .eq('user_id', userId)
          .eq('feature', 'throwable'),
      ]);
      if (profileResult.error) throw profileResult.error;

      const now = Date.now();
      const profile = profileResult.data;
      if (!profile) throw new Error('Profile unavailable');
      const vipStatus = resolveVipStatus(profile);
      if (vipStatus === 'lifetime') {
        return {
          isVip: true,
          unlimited: true,
          freeThrowsRemaining: 0,
          packThrowsRemaining: 0,
          diamondCost: 0,
        };
      }

      // Lifetime exits before this check so an unrelated pack-ledger outage
      // cannot downgrade an unlimited entitlement. Other members consume
      // unexpired pack credits before any Diamond charge.
      if (packResult.error) throw packResult.error;
      const packThrowsRemaining = (packResult.data || [])
        .filter((row) => !row.expires_at || Date.parse(row.expires_at) > now)
        .reduce((sum, row) => sum + Math.max(0, Number(row.uses_remaining) || 0), 0);

      const isVip = vipStatus === 'vip';

      // Every member receives the calendar-month allowance; VIP raises it to 500.
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);

      const { count, error } = await supabase
        .from('throw_usage')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', monthStart.toISOString());

      if (error || count === null) throw error || new Error('Allowance count unavailable');
      const used = count;
      const limit = isVip ? VIP_FREE_THROWS_PER_MONTH : MEMBER_FREE_THROWS_PER_MONTH;
      const remaining = Math.max(0, limit - used);

      return {
        isVip,
        unlimited: false,
        freeThrowsRemaining: remaining,
        packThrowsRemaining,
        diamondCost: remaining > 0 || packThrowsRemaining > 0 ? 0 : DIAMOND_COST_PER_THROW,
      };
    } catch {
      return {
        unavailable: true,
        isVip: false,
        unlimited: false,
        freeThrowsRemaining: 0,
        packThrowsRemaining: 0,
        diamondCost: DIAMOND_COST_PER_THROW,
      };
    }
  }

  /**
   * Use a throwable (deduct from allowance or charge diamonds)
   */
  async useThrowable(
    userId: string,
    throwableId: string
  ): Promise<{
    success: boolean;
    error?: string;
    requestId?: string;
    idempotent?: boolean;
    retrySameRequest?: boolean;
  }> {
    if (!userId) {
      return { success: false, error: 'Authentication Required', retrySameRequest: false };
    }
    const throwable = THROWABLE_MAP.get(throwableId);
    if (!throwable) {
      return { success: false, error: 'Throwable Not Found', retrySameRequest: false };
    }

    try {
      const requestKey = `throwable-pending:${userId}:${throwableId}`;
      const requestId = this.useRequest(requestKey);
      // ── Atomic server path (2026-08-17) ──────────────────────────────────
      // fn_use_throwable serialises the free-allowance check per user
      // (advisory xact lock) and does charge+record in ONE transaction,
      // closing two defects of the old client flow: a two-tab race that
      // could double-spend the last free throw, and a paid path where a
      // failure between deduct_diamonds and the usage insert charged a
      // diamond and recorded nothing. Allowance and price are
      // server-authoritative there.
      // The v1 wrapper creates a new UUID on every call. Retrying a lost
      // response through it could charge twice. v2 replays the same receipt.
      const { data: atomic, error: atomicErr } = await supabase.rpc('fn_use_throwable_v2', {
        p_throwable_id: throwableId,
        p_request_id: requestId,
      });
      if (!atomicErr && atomic && typeof (atomic as any).success === 'boolean') {
        this.finishUse(requestKey, requestId);
        if ((atomic as any).success === true) {
          return {
            success: true,
            requestId,
            idempotent: (atomic as any).idempotent === true,
          };
        }
        return {
          success: false,
          error: normalizeThrowableError((atomic as any).error),
          retrySameRequest: false,
        };
      }
      // The legacy client-side fallback that used to live here is GONE.
      // (See 2026-08-17 session notes: fn_use_throwable is SECURITY DEFINER,
      // derives the user from auth.uid(), and is the only sanctioned path.)
      return { success: false, error: 'Could Not Send Reaction', retrySameRequest: true };
    } catch {
      return { success: false, error: 'Could Not Send Reaction', retrySameRequest: true };
    }
  }

  /**
   * Create throw event for WebSocket broadcast / local render.
   * Accepts legacy (pre-2026-08-20) ids from old clients and bridges them.
   */
  createThrowEvent(
    fromSeat: number,
    toSeat: number,
    throwableId: string,
    eventId?: string
  ): ThrowEvent | null {
    const throwable = this.getThrowableById(throwableId);
    if (!throwable) return null;

    return {
      id: isThrowableEventId(eventId) ? eventId.toLowerCase() : crypto.randomUUID(),
      fromSeat,
      toSeat,
      throwableId: throwable.id,
      throwable,
      timestamp: Date.now(),
    };
  }

  /** Get a single throwable by ID (legacy ids bridged) */
  getThrowableById(id: string): Throwable | null {
    const direct = THROWABLE_MAP.get(id);
    if (direct) return direct;
    const bridged = LEGACY_ID_MAP[id];
    return bridged ? THROWABLE_MAP.get(bridged) || null : null;
  }
}

export const throwableService = new ThrowableServiceClass();
export default throwableService;
