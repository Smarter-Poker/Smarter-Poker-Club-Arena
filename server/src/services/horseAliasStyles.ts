/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HORSE ALIAS STYLES - fifty ways a poker player names themself
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04, verbatim: "EVERY HORSE POKER ALIAS IS ALL TO SIMILAR, TWO
 * WORD NAMES, WITH THE FIRST LETTER OF BOTH WORDS CAPITALIZED, NO ONE WORD
 * NAMES, NO VARIATION IN CAPITALIZATION OF ANY WORDS, NO NUMBERS SPACES OR
 * CHARACTERS... THIS NEEDS TO BE RANDOM AND FEEL 'HUMAN' NOT ALL BE THE SAME
 * TYPE ... CREATE 50 DIFFERENT WAYS TO DISPLAY THE HORSE NAMES."
 *
 * He was right: 867 of 1,000 horses were `CapitalCapital` (RakeHunter,
 * RiverMonk, WheelMonk, RakeJester...) because identityFor() composed every
 * alias as ALIAS_A[i] + ALIAS_B[j] from two twenty-word lists - 400 shapes,
 * one silhouette. A table of them reads as a table of the same person.
 *
 * This module is a set of fifty STYLES. Each style is a small template -
 * "first name and a birth year", "lowercase word with an underscore", "a
 * city code and a name", "ALLCAPS one word", "xX...Xx" - drawn from pools of
 * poker words, everyday words, first names, city codes, and the numbers people
 * actually put in handles (years, lucky numbers, jersey numbers). Every alias
 * is deterministic in the horse's id, so a horse keeps its name across runs,
 * and the `attempt` salt lets a caller step to the next candidate on a
 * collision.
 *
 * THE PLATE BUDGET. SeatSlot cuts a name at 11 characters with no ellipsis
 * (limitSeatName, Dan 2026-08-30: "Clara Hell" over "Clara Hell..."). A style
 * that produces 12+ characters would ship a name the felt silently truncates
 * - the `CheckCowb` in Dan's screenshot is `CheckCowboy` cut. So every style
 * is bounded at MAX_LEN and the generator retries the next attempt if a
 * composition runs long; the tests pin that no alias exceeds it.
 *
 * Usernames are NOT made here. A username is `^[a-z0-9][a-z0-9_.]{2,19}$`
 * (fn_protect_profile_username_and_gate) and comes from the alias via
 * usernameFromAlias(): lowercased, spaces and stray characters folded away,
 * a numeric tail added.
 */

/** The felt shows 11 characters of a name and cuts the rest (SeatSlot.limitSeatName). */
export const MAX_ALIAS_LEN = 11;
export const MIN_ALIAS_LEN = 3;

// ─── Word pools ────────────────────────────────────────────────────────────────

/** Poker vocabulary, short enough to compose with. */
const POKER = [
  'river',
  'nut',
  'chip',
  'ace',
  'blind',
  'tilt',
  'rake',
  'flop',
  'turn',
  'bluff',
  'cooler',
  'runner',
  'boat',
  'wheel',
  'kicker',
  'snap',
  'check',
  'shove',
  'stack',
  'draw',
  'flush',
  'trips',
  'quads',
  'gutshot',
  'limp',
  'jam',
  'squeeze',
  'donk',
  'float',
  'overbet',
  'reraise',
  'straddle',
  'bink',
  'rungood',
  'setmine',
  'heater',
  'freeroll',
  'deuce',
  'trey',
  'cowboy',
  'ladies',
  'rockets',
  'suited',
  'offsuit',
  'broadway',
  'sixes',
  'nines',
  'pocket',
  'tank',
  'muck',
  'rebuy',
  'bubble',
  'button',
  'cutoff',
  'hijack',
  'lojack',
  'utg',
  'ante',
  'sb',
  'bb',
  'allin',
];

/** Things people call themselves. */
const NOUNS = [
  'rat',
  'hunter',
  'king',
  'queen',
  'shark',
  'whale',
  'fox',
  'wolf',
  'bandit',
  'machine',
  'doc',
  'wizard',
  'sniper',
  'grinder',
  'merchant',
  'ghost',
  'monk',
  'jester',
  'pirate',
  'viking',
  'ninja',
  'cobra',
  'hawk',
  'bear',
  'bull',
  'moose',
  'goat',
  'donkey',
  'fish',
  'reg',
  'nit',
  'maniac',
  'rock',
  'legend',
  'rookie',
  'captain',
  'sheriff',
  'outlaw',
  'gambler',
  'hustler',
  'dealer',
  'railbird',
  'degen',
  'whiz',
  'kid',
  'boss',
  'chief',
  'champ',
  'prof',
  'sensei',
];

/** Adjectives that read like a handle, not a paragraph. */
const ADJ = [
  'big',
  'lil',
  'mad',
  'old',
  'young',
  'silent',
  'lucky',
  'sneaky',
  'cold',
  'salty',
  'wild',
  'crazy',
  'slick',
  'fat',
  'skinny',
  'dirty',
  'lazy',
  'fast',
  'slow',
  'sad',
  'happy',
  'angry',
  'tiny',
  'mega',
  'super',
  'dark',
  'sly',
  'mean',
  'nice',
  'loose',
  'tight',
  'deep',
  'short',
  'rich',
  'broke',
  'hungry',
  'sleepy',
  'hot',
  'icy',
  'lone',
];

/** Everyday words people put in handles for no reason poker can explain. */
const EVERYDAY = [
  'taco',
  'pizza',
  'coffee',
  'beer',
  'whiskey',
  'truck',
  'garage',
  'moon',
  'sun',
  'storm',
  'thunder',
  'river',
  'lake',
  'mountain',
  'desert',
  'cactus',
  'pickle',
  'waffle',
  'biscuit',
  'noodle',
  'banana',
  'mango',
  'pepper',
  'salsa',
  'burrito',
  'donut',
  'bagel',
  'pretzel',
  'nacho',
  'cookie',
  'tofu',
  'ramen',
  'sushi',
  'gumbo',
  'brisket',
  'pancake',
  'muffin',
  'peanut',
  'walnut',
  'cashew',
  'jalapeno',
  'espresso',
  'latte',
  'mocha',
  'cocoa',
  'velvet',
  'denim',
  'flannel',
  'copper',
  'cobalt',
  'neon',
];

const FIRST = [
  'Tony',
  'Mike',
  'Danny',
  'Ray',
  'Sam',
  'Jules',
  'Greg',
  'Tyler',
  'Will',
  'Nat',
  'Tim',
  'Kyle',
  'Ian',
  'Val',
  'Luc',
  'Kayla',
  'Rachel',
  'Caro',
  'Jordan',
  'Marcus',
  'Elena',
  'Diego',
  'Priya',
  'Connor',
  'Amara',
  'Viktor',
  'Nadia',
  'Luis',
  'Grace',
  'Owen',
  'Bianca',
  'Rashid',
  'Freya',
  'Tomas',
  'Ingrid',
  'Julien',
  'Sofia',
  'Andre',
  'Maya',
  'Kenji',
  'Rosa',
  'Duncan',
  'Lena',
  'Micah',
  'Talia',
  'Ravi',
  'Nora',
  'Ezra',
  'Camille',
  'Jake',
  'Eddie',
  'Frank',
  'Vinny',
  'Sal',
  'Lou',
  'Moe',
  'Gus',
  'Otis',
  'Hank',
  'Earl',
  'Wade',
  'Cole',
  'Reid',
  'Beau',
  'Cash',
  'Jett',
  'Rex',
  'Ace',
  'Bea',
  'Ivy',
  'Zoe',
  'Mia',
  'Ana',
  'Liv',
  'Gia',
  'Kim',
  'Jen',
  'Deb',
  'Pam',
  'Trey',
  'Drew',
  'Chad',
  'Brad',
  'Kurt',
  'Dale',
  'Russ',
  'Wes',
  'Rob',
  'Bob',
];

const LAST = [
  'Chen',
  'Okafor',
  'Marino',
  'Delgado',
  'Whitfield',
  'Nakamura',
  'Sorensen',
  'Bakker',
  'Ferreira',
  'Voss',
  'Halloran',
  'Ibarra',
  'Petrov',
  'Ashford',
  'Quintero',
  'Larsen',
  'Duval',
  'Mercado',
  'Reyes',
  'Stroud',
  'Romano',
  'Kelly',
  'Nguyen',
  'Patel',
  'Lopez',
  'Garcia',
  'Silva',
  'Ortiz',
  'Ruiz',
  'Diaz',
  'Cruz',
  'Kim',
  'Park',
  'Wong',
  'Tran',
  'Lee',
  'Khan',
  'Ali',
  'Costa',
  'Rossi',
  'Bruno',
  'Weber',
  'Meyer',
  'Klein',
  'Novak',
  'Kowal',
  'Boyd',
  'Hale',
  'Ross',
  'Ford',
];

/** City and region codes people wear in their handles. */
const CITY = [
  'ATL',
  'NOLA',
  'PDX',
  'MKE',
  'OKC',
  'SLC',
  'CBus',
  'LBC',
  'PVD',
  'PHX',
  'SEA',
  'CHI',
  'LA',
  'NYC',
  'BK',
  'BX',
  'DFW',
  'HOU',
  'SA',
  'ABQ',
  'DEN',
  'KC',
  'STL',
  'MSP',
  'DET',
  'CLE',
  'PIT',
  'BOS',
  'PHL',
  'DC',
  'RVA',
  'CLT',
  'RDU',
  'MIA',
  'TPA',
  'JAX',
  'BHM',
  'NSH',
  'MEM',
  'LOU',
  'CIN',
  'IND',
  'BUF',
  'ROC',
  'SF',
  'OAK',
  'SD',
  'LV',
  'Vegas',
  'Reno',
  'Tahoe',
  'Jersey',
  'Texas',
  'Philly',
  'Bama',
  'Cali',
];

/** The three- and four-letter members of the pools above, for triple compositions. */
const SHORT_ADJ = ADJ.filter((w) => w.length <= 4);
const SHORT_POKER = POKER.filter((w) => w.length <= 4);
const SHORT_NOUNS = NOUNS.filter((w) => w.length <= 4);

const HONORIFIC = [
  'Mr',
  'Ms',
  'Mrs',
  'Dr',
  'Sir',
  'Big',
  'Lil',
  'Uncle',
  'Auntie',
  'Papa',
  'Mama',
  'Coach',
];

/** Two-digit birth years people put after their name. */
const YEAR2 = [
  '69',
  '71',
  '74',
  '77',
  '78',
  '80',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '96',
  '97',
  '98',
  '99',
  '01',
  '02',
  '03',
];
/** Lucky and jersey numbers. */
const LUCKY = [
  '7',
  '11',
  '13',
  '21',
  '22',
  '23',
  '24',
  '27',
  '33',
  '42',
  '44',
  '55',
  '66',
  '77',
  '88',
  '99',
  '100',
  '111',
  '222',
  '420',
  '710',
  '777',
  '808',
  '888',
  '1k',
];

// ─── Deterministic randomness ────────────────────────────────────────────────

/** FNV-1a, the scheme the rest of the fleet keys on. */
function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** A tiny xorshift stream seeded from the id, so one hash yields many draws. */
class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed || 0x9e3779b9;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.next() % arr.length];
  }
  chance(p: number): boolean {
    return (this.next() % 1000) / 1000 < p;
  }
}

// ─── Case helpers ─────────────────────────────────────────────────────────────

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const lower = (w: string) => w.toLowerCase();
const upper = (w: string) => w.toUpperCase();
/** r1v3r-style substitutions, applied to at most two letters so it stays readable. */
function leet(w: string, r: Rng): string {
  const map: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };
  let swapped = 0;
  return w
    .split('')
    .map((c) => {
      if (swapped < 2 && map[c.toLowerCase()] && r.chance(0.5)) {
        swapped++;
        return map[c.toLowerCase()];
      }
      return c;
    })
    .join('');
}

// ─── The fifty styles ─────────────────────────────────────────────────────────

type Style = (r: Rng) => string;

/**
 * Each entry is one way a real player writes a handle. Order matters only for
 * determinism (a horse's style index is hashed from its id); the list is what
 * the tests count.
 */
export const ALIAS_STYLES: readonly Style[] = [
  // 1  CamelCase poker pair - the old house style, now one of fifty
  (r) => cap(r.pick(POKER)) + cap(r.pick(NOUNS)),
  // 2  the same pair, all lowercase, run together
  (r) => lower(r.pick(POKER)) + lower(r.pick(NOUNS)),
  // 3  lowercase pair with a numeric tail
  (r) => lower(r.pick(POKER)) + lower(r.pick(NOUNS)) + r.pick(LUCKY),
  // 4  one Capitalized poker word
  (r) => cap(r.pick(POKER)),
  // 5  one ALLCAPS word
  (r) => upper(r.pick(r.chance(0.5) ? POKER : NOUNS)),
  // 6  one lowercase word
  (r) => lower(r.pick(r.chance(0.5) ? POKER : EVERYDAY)),
  // 7  snake_case pair
  (r) => lower(r.pick(POKER)) + '_' + lower(r.pick(NOUNS)),
  // 8  snake_case pair with digits
  (r) => lower(r.pick(ADJ)) + '_' + lower(r.pick(NOUNS)) + '_' + r.pick(LUCKY),
  // 9  first name and a four-digit birth year
  (r) => lower(r.pick(FIRST)) + '19' + r.pick(YEAR2.filter((y) => y > '10')),
  // 10 First name and a two-digit year
  (r) => r.pick(FIRST) + r.pick(YEAR2),
  // 11 firstlast, lowercase
  (r) => lower(r.pick(FIRST)) + lower(r.pick(LAST)),
  // 12 initial + surname
  (r) => lower(r.pick(FIRST).charAt(0)) + lower(r.pick(LAST)),
  // 13 Name + city code
  (r) => r.pick(FIRST) + r.pick(CITY),
  // 14 City code + name
  (r) => r.pick(CITY) + r.pick(FIRST),
  // 15 city_name, lowercase
  (r) => lower(r.pick(CITY)) + '_' + lower(r.pick(FIRST)),
  // 16 xX...Xx
  (r) => 'xX' + cap(r.pick(NOUNS)) + 'Xx',
  // 17 leetspeak
  (r) => leet(lower(r.pick(POKER)) + lower(r.pick(NOUNS)), r),
  // 18 Adjective + Noun, CamelCase
  (r) => cap(r.pick(ADJ)) + cap(r.pick(NOUNS)),
  // 19 adjective + noun, lowercase run together
  (r) => lower(r.pick(ADJ)) + lower(r.pick(NOUNS)),
  // 20 adjective_noun
  (r) => lower(r.pick(ADJ)) + '_' + lower(r.pick(EVERYDAY)),
  // 21 Big/Lil + Name
  (r) => r.pick(['Big', 'Lil', 'Old', 'Young']) + r.pick(FIRST),
  // 22 honorific + word with a space, the way people actually type it
  (r) => r.pick(HONORIFIC) + ' ' + cap(r.pick(r.chance(0.5) ? POKER : FIRST)),
  // 23 Mr/Ms + Noun
  (r) => r.pick(['Mr', 'Ms', 'Dr']) + cap(r.pick(NOUNS)),
  // 24 The + Noun
  (r) => 'The' + cap(r.pick(NOUNS)),
  // 25 the_noun
  (r) => 'the_' + lower(r.pick(r.chance(0.5) ? NOUNS : POKER)),
  // 26 noun_year
  (r) => lower(r.pick(NOUNS)) + '_' + r.pick(YEAR2),
  // 27 NamePoker
  (r) => r.pick(FIRST) + 'Poker',
  // 28 poker_name
  (r) => 'poker' + lower(r.pick(FIRST)),
  // 29 Name Jr / Name Sr
  (r) => r.pick(FIRST) + r.pick(['Jr', 'Sr', 'III']),
  // 30 first.last
  (r) => lower(r.pick(FIRST)) + '.' + lower(r.pick(LAST)),
  // 31 f.last + digits
  (r) => lower(r.pick(FIRST).charAt(0)) + '.' + lower(r.pick(LAST)) + r.pick(YEAR2),
  // 32 ALLCAPS pair
  (r) => upper(r.pick(POKER)) + upper(r.pick(NOUNS)),
  // 33 CamelCase pair with digits
  (r) => cap(r.pick(POKER)) + cap(r.pick(NOUNS)) + r.pick(LUCKY),
  // 34 Three short words, CamelCase (short pools, so it fits the plate)
  (r) => cap(r.pick(SHORT_ADJ)) + cap(r.pick(SHORT_POKER)) + cap(r.pick(SHORT_NOUNS)),
  // 35 lowerCamel
  (r) => lower(r.pick(POKER)) + cap(r.pick(NOUNS)),
  // 36 Word + Name with a space
  (r) => cap(r.pick(POKER)) + ' ' + r.pick(FIRST),
  // 37 Word + lucky number
  (r) => cap(r.pick(POKER)) + r.pick(LUCKY),
  // 38 x + word
  (r) => 'x' + lower(r.pick(r.chance(0.5) ? NOUNS : POKER)),
  // 39 doubled last letter, the "grinderr" habit
  (r) => {
    const w = lower(r.pick(NOUNS));
    return w + w.charAt(w.length - 1);
  },
  // 40 everyday word + number
  (r) => lower(r.pick(EVERYDAY)) + r.pick(LUCKY),
  // 41 two everyday words, CamelCase
  (r) => cap(r.pick(EVERYDAY)) + cap(r.pick(EVERYDAY)),
  // 42 a first name, capitalised
  (r) => r.pick(FIRST),
  // 43 a first name, lowercase
  (r) => lower(r.pick(FIRST)),
  // 44 Name + surname initial
  (r) => r.pick(FIRST) + r.pick(LAST).charAt(0),
  // 45 Name + The + Noun
  (r) => r.pick(FIRST) + 'The' + cap(r.pick(NOUNS)),
  // 46 Uncle/Auntie/Papa/Mama + Name
  (r) => r.pick(['Uncle', 'Auntie', 'Papa', 'Mama', 'Coach']) + r.pick(FIRST),
  // 47 word + lucky triple
  (r) => lower(r.pick(POKER)) + r.pick(['777', '888', '420', '111', '222', '007']),
  // 48 poker pair + one digit
  (r) => lower(r.pick(POKER)) + lower(r.pick(POKER)) + String(1 + (r.next() % 9)),
  // 49 City + Noun
  (r) => r.pick(CITY) + cap(r.pick(NOUNS)),
  // 50 Region + Name with an underscore
  (r) =>
    r.pick(['Texas', 'Jersey', 'Vegas', 'Philly', 'Cali', 'Bama', 'Dixie', 'Yankee']) +
    '_' +
    r.pick(FIRST),
];

/** Characters an alias may carry: letters, digits, one space, `_`, `.`. */
export const ALIAS_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_. ]*[A-Za-z0-9]$/;

/**
 * The alias for a horse, deterministic in its id. `attempt` steps to the next
 * candidate (a different style and different draws) when a caller finds a
 * collision; the sweep and the migration both use it.
 */
export function styledAlias(horseId: string, attempt = 0): string {
  // Bounded search: a style whose composition runs past the plate budget
  // moves to the next style rather than shipping a name the felt would cut.
  for (let step = 0; step < 200; step++) {
    const seed = fnv(`${horseId}:alias:${attempt}:${step}`);
    const r = new Rng(seed);
    const style = ALIAS_STYLES[seed % ALIAS_STYLES.length];
    const candidate = style(r);
    if (
      candidate.length >= MIN_ALIAS_LEN &&
      candidate.length <= MAX_ALIAS_LEN &&
      ALIAS_SHAPE.test(candidate)
    ) {
      return candidate;
    }
  }
  // Unreachable in practice (single-word styles always fit); a bare word
  // rather than a throw, so a horse is never left without a name.
  return cap(POKER[fnv(horseId) % POKER.length]);
}

/** Which of the fifty styles a candidate came from - for the tests and the audit. */
export function styleIndexFor(horseId: string, attempt = 0): number {
  for (let step = 0; step < 200; step++) {
    const seed = fnv(`${horseId}:alias:${attempt}:${step}`);
    const r = new Rng(seed);
    const idx = seed % ALIAS_STYLES.length;
    const candidate = ALIAS_STYLES[idx](r);
    if (
      candidate.length >= MIN_ALIAS_LEN &&
      candidate.length <= MAX_ALIAS_LEN &&
      ALIAS_SHAPE.test(candidate)
    ) {
      return idx;
    }
  }
  return -1;
}

/**
 * A username the profiles trigger accepts (`^[a-z0-9][a-z0-9_.]{2,19}$`),
 * derived from the alias so the two read as the same person: lowercase,
 * spaces folded to nothing, anything else dropped, and a short numeric tail
 * from the id so two horses with the same alias shape never share one.
 */
export function usernameFromAlias(alias: string, horseId: string): string {
  let base = alias
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9_.]/g, '')
    .replace(/^[_.]+/, '');
  if (base.length < 2) base = 'player';
  const tail = String((fnv(`${horseId}:user`) % 900) + 100);
  return (base + tail).slice(0, 20);
}
