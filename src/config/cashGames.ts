/**
 * CASH GAMES - the client's vocabulary for the New Cash Game flow (Operation
 * Table Stakes, Slice 1; OPORD 1.3 sections 7-8, OPORD 1.4 section 2.6).
 *
 * The DATABASE owns the defaults (`fn_cash_template_defaults`) and the
 * validation (`fn_cash_game_create`). This file holds only what a picker has
 * to know before it asks: the two offered formats and historical aliases, the variants the engine deals
 * today (pinned against the engine's own KNOWN_VARIANTS by
 * tests/unit/cashGamesVocabulary.test.ts), and the shape of a resolved
 * snapshot so the overrides panel is typed.
 */

export type CashTemplate = 'classic' | 'action' | 'madness';

/** Canonical offered format; historical identifiers remain readable. */
export function cashTemplateKey(template: string): string {
  const key = template.toLowerCase();
  return key === 'action' || key === 'lightning' ? 'madness' : key;
}

/** Pineapple's discard round belongs to the physical Classic host. */
export function cashTemplateVariantAvailable(
  template: string | null,
  variant: string | null
): boolean {
  return !(
    cashTemplateKey(template ?? '') === 'madness' &&
    (variant === 'pineapple' || variant === 'pineapple_holdem')
  );
}

export const PINEAPPLE_CLASSIC_NOTE =
  'Pineapple Uses Classic Games. Its Discard Round Is Not Available In Lightning Games.';

export const LIGHTNING_RULES_SUMMARY = 'Big Blind Ante, 40% Minimum VPIP';

export const CASH_TEMPLATES: ReadonlyArray<{ id: CashTemplate; label: string; blurb: string }> = [
  {
    id: 'classic',
    label: 'Classic',
    blurb:
      'Standard Ring Game. No Bombs. PLO5 And PLO6 Play A Big Blind Ante And 50% Minimum VPIP; Every Other Game Has No Ante And No Minimum VPIP.',
  },
  {
    id: 'madness',
    label: 'Lightning Games',
    blurb: `${LIGHTNING_RULES_SUMMARY}. Five Players Minimum, Three Seconds For The Sixth.`,
  },
];

/**
 * Render the cadence stored in a game snapshot. Historical tokens remain
 * readable because settled and retired game snapshots are preserved.
 */
export type CashBombTrigger = 'timed_10m' | 'timed_15m' | 'timed_20m' | 'every_orbit';

export function bombCadenceLabel(
  trigger: CashBombTrigger | string | null | undefined,
  short = false
): string {
  const m = /^timed_(\d+)m$/.exec(String(trigger ?? ''));
  if (m) return `Every ${m[1]} ${short ? 'Min' : 'Minutes'}`;
  if (trigger === 'every_orbit') return 'Every Orbit';
  return 'On A Timer';
}

/**
 * WHAT CHANGES, PRINTED BESIDE THE STYLE ON EVERY CASH CARD (Dan 2026-10-15):
 * "WHEN CASH GAMES ARE DISPLAYED WITH 'CLASSIC' 'ACTION' AND 'MADNESS' THERE
 * SHOULD BE A DESCRIPTION NEXT TO THEM FOR ACTION AND MADNESS EXPLAINING WHAT
 * CHANGES THE VARIATION OF THE GAME."
 *
 * Classic prints no additional note. Lightning uses the same 40% VPIP,
 * big blind ante and five/six-player promise in the picker and on each card.
 * Historical Action identifiers resolve to that one offered format.
 */
export function cashTemplateNote(template: string | null | undefined): string | null {
  if (!template) return null;
  const id = cashTemplateKey(String(template));
  if (id === 'classic') return null;
  const hit = CASH_TEMPLATES.find((t) => t.id === cashTemplateKey(id));
  return hit ? LIGHTNING_RULES_SUMMARY : null;
}

/**
 * Every variant the engine deals, in the order the picker shows them. A
 * variant that is NOT here is offered disabled with "This Variant Is Not
 * Available Yet" and the database refuses it too (ROE 16) - nothing is ever
 * silently saved as NLHE.
 */
export const CASH_VARIANTS: ReadonlyArray<{
  id: string;
  label: string;
  family: 'holdem' | 'plo' | 'shortdeck' | 'pineapple';
}> = [
  { id: 'nlh', label: 'NLH', family: 'holdem' },
  { id: 'plo4', label: 'PLO4', family: 'plo' },
  { id: 'plo5', label: 'PLO5', family: 'plo' },
  { id: 'plo6', label: 'PLO6', family: 'plo' },
  { id: 'plo8', label: 'PLO8', family: 'plo' },
  { id: 'flo8', label: 'FLO8', family: 'plo' },
  { id: 'flh', label: 'FLH', family: 'holdem' },
  { id: 'short_deck', label: 'Short Deck', family: 'shortdeck' },
  { id: 'pineapple', label: 'Pineapple', family: 'pineapple' },
];

export const CASH_VARIANT_IDS: readonly string[] = CASH_VARIANTS.map((v) => v.id);

/** The long name a player reads on a game card. */
export const CASH_VARIANT_LONG: Readonly<Record<string, string>> = {
  nlh: "No Limit Hold'em",
  plo4: 'Pot Limit Omaha',
  plo5: 'Pot Limit Omaha 5',
  plo6: 'Pot Limit Omaha 6',
  plo8: 'Omaha Hi-Lo',
  flo8: 'Fixed Limit Omaha Hi-Lo',
  flh: "Fixed Limit Hold'em",
  short_deck: 'Short Deck',
  pineapple: "Pineapple Hold'em",
};

export function isDealtVariant(id: string | null | undefined): boolean {
  return !!id && CASH_VARIANT_IDS.includes(id);
}

/** What fn_cash_template_defaults returns and fn_cash_game_create resolves. */
export interface CashRulesetSnapshot {
  template: CashTemplate;
  variant: string;
  family: 'holdem' | 'plo' | 'shortdeck' | 'pineapple';
  seats: number;
  seats_locked: boolean;
  seat_choices: number[];
  min_buyin_bb: number;
  max_buyin_bb: number;
  regular_ante: 'none' | 'sb' | 'bb';
  vpip_floor: number;
  vpip_window: number;
  bombs: {
    enabled: boolean;
    trigger: CashBombTrigger | null;
    ante_bb: number | null;
    boards: number | null;
  };
  straddle: false;
  stay_clock_min: number;
  rejoin_window_min: number;
  run_it_n_times: 'opt_in';
  rake: 'existing';
}

/**
 * THE FOUR FIELDS A HOST DOES NOT EDIT (2026-09-09,
 * docs/changelog/2026-09-09-a-classic-game-has-no-antes-and-no-bombs.md).
 *
 * The template blurb is a promise: Classic has no antes, bombs or minimum
 * VPIP; Lightning has a big blind ante and 40% minimum VPIP. Since
 * that date fn_cash_game_create resolves every one of these from
 * fn_cash_template_defaults and reads NOTHING the caller sends for them. So
 * the overrides payload does not carry them, the rules step prints them as
 * the template's promise, and a host is never shown a control the server
 * would ignore. tests/cash-games-are-created-from-a-template.law.test.tsx
 * pins both halves.
 */
export const TEMPLATE_LOCKED_RULES = [
  'regular_ante',
  'vpip_floor',
  'vpip_window',
  'bombs',
] as const;
export type TemplateLockedRule = (typeof TEMPLATE_LOCKED_RULES)[number];

/** The host's editable copy of the section 8 fields, sent as `p_overrides`. */
export interface CashGameOverrides {
  min_buyin_bb: number;
  max_buyin_bb: number;
  stay_clock_min: number;
  rejoin_window_min: number;
  options: {
    is_private: boolean;
    is_vip_only: boolean;
    is_anonymous: boolean;
    ban_chat: boolean;
    insurance_enabled: boolean;
    seven_deuce_enabled: boolean;
    action_time_seconds: number;
  };
}

export function overridesFromSnapshot(s: CashRulesetSnapshot): CashGameOverrides {
  return {
    min_buyin_bb: s.min_buyin_bb,
    max_buyin_bb: s.max_buyin_bb,
    stay_clock_min: s.stay_clock_min,
    rejoin_window_min: s.rejoin_window_min,
    options: {
      is_private: false,
      is_vip_only: false,
      is_anonymous: false,
      ban_chat: false,
      insurance_enabled: false,
      seven_deuce_enabled: false,
      action_time_seconds: 15,
    },
  };
}

/** The template's name as a host reads it in a readout. */
export function templateLabel(t: CashTemplate | string | null | undefined): string {
  const hit = CASH_TEMPLATES.find((x) => x.id === cashTemplateKey(String(t ?? '')));
  return hit ? hit.label : 'Classic';
}

/**
 * The promise each locked rule makes, in Title Case, from the snapshot the
 * server returned. Rendered read-only in the rules step. Three lines, one per
 * thing the blurb names; the VPIP window rides with the floor because the
 * floor is meaningless without it.
 */
export function templatePromiseLines(
  s: Pick<CashRulesetSnapshot, 'template' | 'regular_ante' | 'vpip_floor' | 'vpip_window' | 'bombs'>
): ReadonlyArray<{ key: 'ante' | 'vpip' | 'bombs'; label: string; value: string; note: string }> {
  const by = `Set By The ${templateLabel(s.template)} Template`;
  const ante =
    s.regular_ante === 'sb'
      ? 'One Small Blind From Each Dealt In Player'
      : s.regular_ante === 'bb'
        ? 'One Big Blind, Paid By The Player In The Big Blind'
        : 'No Ante';
  const vpip =
    (s.vpip_floor ?? 0) > 0 ? `${s.vpip_floor}% Over ${s.vpip_window} Hands` : 'No Minimum VPIP';
  const vpipNote =
    (s.vpip_floor ?? 0) > 0
      ? `${by}. Players Under This Voluntarily Put In Pot Rate Are Cashed Out After The Hand.`
      : `${by}. Nobody Is Cashed Out For Playing Tight.`;
  const bombs = s.bombs?.enabled
    ? `${(s.bombs.boards ?? 2) >= 3 ? 'Triple' : 'Double'} Board, ${s.bombs.ante_bb ?? 0} BB Ante, ${bombCadenceLabel(
        s.bombs.trigger
      )}`
    : 'No Bomb Pots';
  const bombsNote = s.bombs?.enabled
    ? `${by}. Every Dealt In Player Posts The Bomb Ante Instead Of The Blinds.`
    : `${by}. Every Hand Is Dealt With Blinds.`;
  return [
    { key: 'ante', label: 'Ante', value: ante, note: by },
    { key: 'vpip', label: 'Minimum VPIP', value: vpip, note: vpipNote },
    { key: 'bombs', label: 'Bomb Pots', value: bombs, note: bombsNote },
  ];
}

/**
 * THE BLIND BAND, the client twin of public.fn_cash_stake_band and the
 * engine's stakeBandForBigBlind (docs/changelog/2026-09-05-action-and-madness-
 * are-one-game-per-blind-category.md). Action and Madness run ONE game per
 * band per variant per club; the stakes chips use this to grey a rung the club
 * already holds before the server has to refuse it. Pinned to the migration's
 * CASE arms by tests/unit/cashGamesVocabulary.test.ts.
 */
export type CashStakeBand = 'micro' | 'low' | 'mid' | 'high';

export function stakeBandForBigBlind(bigBlind: number): CashStakeBand {
  const bb = Number(bigBlind);
  if (!Number.isFinite(bb) || bb <= 0) return 'low';
  if (bb <= 0.5) return 'micro';
  if (bb <= 2) return 'low';
  if (bb <= 6) return 'mid';
  return 'high';
}

/** Dan's names for the four bands: "ONE MICRO, ONE SMALL, ONE MID, AND ONE HIGH". */
export const STAKE_BAND_LABEL: Readonly<Record<CashStakeBand, string>> = {
  micro: 'Micro Stakes',
  low: 'Small Stakes',
  mid: 'Mid Stakes',
  high: 'High Stakes',
};

/** A game the club already runs, as the stakes step needs to know it. */
export interface ExistingCashGame {
  name: string;
  template_name: string;
  variant: string;
  sb: number;
  bb: number;
  must_move: boolean;
}

/** Midway's additional half/one rung does not change horse stake bands. */
export const MIDWAY_CASH_HOST_ID = 'fade0000-0000-0000-0000-000000000001';
export function cashGameCategoryKey(
  clubId: string | null | undefined,
  variant: string,
  sb: number,
  bb: number
): string {
  if (
    clubId === MIDWAY_CASH_HOST_ID &&
    ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'].includes(variant) &&
    sb === 0.5 &&
    bb === 1
  )
    return 'half_one';
  return stakeBandForBigBlind(bb);
}

/**
 * Why a stakes rung cannot be opened for this template and variant, or null.
 * Mirrors the two database refusals: cash_games_one_per_key (a must-move game
 * is one per exact stakes) and zz_one_game_per_blind_category (Action and
 * Madness are one per band, must-move or manual). Classic manual tables are
 * unrestricted.
 */
export function stakesRungTaken(
  existing: ReadonlyArray<ExistingCashGame>,
  template: CashTemplate,
  variant: string,
  sb: number,
  bb: number,
  mustMove: boolean,
  clubId?: string | null
): string | null {
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  for (const g of existing) {
    const existingTemplate = g.template_name === 'action' ? 'madness' : g.template_name;
    const requestedTemplate = template === 'action' ? 'madness' : template;
    if (existingTemplate !== requestedTemplate || g.variant !== variant) continue;
    if (
      template !== 'classic' &&
      cashGameCategoryKey(clubId, variant, g.sb, g.bb) ===
        cashGameCategoryKey(clubId, variant, sb, bb)
    ) {
      return `This Club Already Runs ${g.name} As Its ${templateLabel(template)} ${
        STAKE_BAND_LABEL[stakeBandForBigBlind(bb)]
      } Game`;
    }
    if (mustMove && g.must_move && same(g.sb, sb) && same(g.bb, bb)) {
      return `This Club Already Runs ${g.name}`;
    }
  }
  return null;
}

/**
 * The refusals fn_cash_game_create raises, in words a host can read.
 *
 * Every code the LIVE function body can raise has a line here, and
 * tests/unit/cashGamesVocabulary.test.ts diffs this function against the
 * RAISE EXCEPTION codes in the migrations that define it, so a code added in
 * SQL without copy fails there rather than reaching a host as raw Postgres.
 */
export function cashGameCreateRefusalText(raw: unknown): string | null {
  const m = String((raw as { message?: string })?.message ?? raw ?? '');
  if (!m) return null;
  // 20260924102056: an enforced commerce admission refuses a NEW table (or
  // insurance on it) with a finished Title Case sentence from
  // fn_ca_commerce_admission_message, HINT operating_access_required. It is
  // the house copy already, so it is shown exactly as the server wrote it.
  if (
    (raw as { hint?: string })?.hint === 'operating_access_required' ||
    /^(This (Club|Union) Needs (Active Operating Access|The Insurance Module) |Operating Access Is Required )/.test(
      m
    )
  ) {
    return m.trim();
  }
  if (/VARIANT_UNAVAILABLE/.test(m)) return 'This Variant Is Not Available Yet';
  // zz_one_game_per_blind_category (Action and Madness are one game per blind
  // band): "... already runs NLH 0.25/0.50 Action (0.25/0.50) as its Action
  // micro game. Close it before opening another." The game it names is the
  // one HOLDING the band, which is not the stakes the host just picked.
  if (/ONE_GAME_PER_BLIND_CATEGORY/.test(m)) {
    const which = m.match(/already runs (.+?) as its (\w+) (micro|low|mid|high) game/);
    return which
      ? `This Club Already Runs ${which[1]} As Its ${templateLabel(which[2].toLowerCase())} ${
          STAKE_BAND_LABEL[which[3] as CashStakeBand]
        } Game. Close It Before Opening Another.`
      : 'This Club Already Runs A Game At That Blind Band. Close It Before Opening Another.';
  }
  if (/GAME_EXISTS/.test(m)) {
    const which = m.match(/already runs (.+)$/);
    return which
      ? `This Club Already Runs ${which[1]}. Join That Game Instead.`
      : 'This Club Already Runs That Game. Join It Instead.';
  }
  if (/NOT_AUTHORIZED/.test(m)) return 'You Cannot Create Games In This Club';
  if (/requires an authenticated caller/.test(m)) return 'Sign In To Create A Game';
  // The floor is the template's (10 / 120 today); the server says it in the
  // message ("the minimum is 10"), so the copy reads it back rather than
  // restating a number that could drift.
  if (/STAY_CLOCK_BELOW_FLOOR/.test(m)) {
    const floor = m.match(/the minimum is (\d+)/);
    return floor
      ? `The Stay Clock Can Only Be Raised Above ${floor[1]} Minutes`
      : 'The Stay Clock Can Only Be Raised Above 10 Minutes';
  }
  if (/REJOIN_WINDOW_BELOW_FLOOR/.test(m)) {
    const floor = m.match(/the minimum is (\d+)/);
    return floor
      ? `The Rejoin Window Can Only Be Raised Above ${floor[1]} Minutes`
      : 'The Rejoin Window Can Only Be Raised Above 120 Minutes';
  }
  if (/HANDEDNESS_INVALID/.test(m)) return 'That Table Size Is Not Offered For This Game';
  if (/BUYIN_BAND_INVALID/.test(m)) return 'The Buy In Range Is Not Valid';
  if (/BOMB_/.test(m)) return 'The Bomb Pot Settings Are Not Valid';
  if (/STAKES_INVALID/.test(m)) return 'Those Stakes Are Not Valid';
  if (/SESSION_REVOKED/.test(m)) return 'Your Session Is Signed Out. Sign In Again.';
  if (/TEMPLATE_UNKNOWN/.test(m)) return 'Pick A Template First';
  if (/LIGHTNING_VARIANT_NOT_SUPPORTED/.test(m)) return PINEAPPLE_CLASSIC_NOTE;
  if (/ANTE_INVALID/.test(m)) return 'The Ante Setting Is Not Valid';
  if (/VPIP_WINDOW_INVALID/.test(m)) return 'The VPIP Window Must Be Between 10 And 200 Hands';
  if (/VPIP_INVALID/.test(m)) return 'The Minimum VPIP Must Be Between 0 And 100 Percent';
  if (/CLOCK_TOO_LONG/.test(m)) return 'The Stay Clock Or Rejoin Window Is Too Long';
  if (/CLUB_REQUIRED/.test(m)) return 'This Screen Needs A Club';
  // A locked field arrived different from the template (an old bundle, or a
  // hand-built payload). The server refuses rather than quietly using its own.
  if (/OVERRIDE_LOCKED/.test(m)) {
    const which = m.match(/OVERRIDE_LOCKED: ([a-z_]+) is set by the (\w+) template/);
    return which
      ? `The ${ruleFieldLabel(which[1])} Is Set By The ${templateLabel(which[2])} Template. Reload And Try Again.`
      : 'That Rule Is Set By The Template. Reload And Try Again.';
  }
  if (/OVERRIDE_INVALID/.test(m)) {
    const which = m.match(/OVERRIDE_INVALID: ([a-z_]+)/);
    return which
      ? `The ${ruleFieldLabel(which[1])} Setting Is Not Valid`
      : 'A Setting Is Not Valid';
  }
  return null;
}

function titleWords(snake: string): string {
  return snake
    .split('_')
    .filter(Boolean)
    .map((w) => (w === 'vpip' ? 'VPIP' : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** A rule field as players read it: the floor is printed as the minimum VPIP (Dan 2026-10-16). */
function ruleFieldLabel(snake: string): string {
  if (snake === 'vpip_floor') return 'Minimum VPIP';
  return titleWords(snake);
}
