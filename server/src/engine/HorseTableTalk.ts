/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A HORSE SPEAKS AT THE TABLE, THE SAME WAY A PLAYER DOES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED 2026-09-08: `table_chat` held 6 messages in its entire history, all
 * from one human. Across 1,000 horses and 1,271 seats occupied at that moment,
 * a horse had NEVER sent a single message. Not rarely - never.
 *
 * That is not a live tell today, because nobody chats: a silent horse sits at
 * a table of silent humans. It becomes the loudest tell on the platform the
 * day real players arrive. A human types "nh", eight seats never answer, every
 * table, every night. Dan's ruling on the five-second rebuy pause is exactly
 * this case:
 *
 *   "TABLES ARE DESIGNED TO BE USED BY EVERYONE, EVERY HORSE OR HUMAN PLAYER
 *    NEEDS TO BE TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN
 *    EVERYTHING ... IF YOU DIDN'T GIVE THEM THE SAME EXACT FEATURES AND
 *    FUNCTIONALITY, PEOPLE WOULD NOTICE!"
 *
 * Chat is a feature every human seat has and no horse seat had. Silence was an
 * exclusion, so this removes it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULES IT PLAYS BY, AND WHY EACH ONE
 *
 * 1. THE SAME DOOR. It INSERTs into `table_chat` with `message_type: 'player'`
 *    - the identical row a human's composer writes. No second table, no flag,
 *    no `is_horse` anywhere in the payload, and nothing in the row says which
 *    kind of player wrote it.
 *
 * 2. THE SAME REFUSALS, ENFORCED HERE. The engine holds the service role, so
 *    the RLS policy that stops a human (`table_chat_insert`, which calls
 *    `fn_table_chat_is_silenced`) does not apply to it. A silenced horse that
 *    kept talking would be the tell instead. So this asks the SAME function
 *    before every message, and a table with `ban_chat`, a tournament with
 *    `ban_chat`, or an unexpired `table_chat_mutes` row silences the horse
 *    exactly as it silences a person. Cannot read the answer? Say nothing -
 *    the quiet failure is the safe one here, and it is COUNTED, not swallowed
 *    (CLAUDE.md 10.86: unknown is its own outcome).
 *
 * 3. NEVER ON A CLOCK. Every gate is probabilistic and every delay is drawn,
 *    because a fixed cadence is measurable and a measurable cadence is a tell
 *    - the lesson of the tempo work (V35). The typing delay is drawn from a
 *    distribution and lands the message SECONDS after the moment that prompted
 *    it, never on the same tick as the pot award.
 *
 * 4. THE FLEET IS NOT UNIFORM. Chattiness is derived from a hash of the
 *    horse's own id, so roughly a third of the fleet never speaks at all, most
 *    speak rarely, and a few are talkative - which is what a room of people
 *    looks like. A uniform 8% across 1,000 horses would itself be a signature.
 *
 * 5. IT DOES NOT REPEAT ITSELF, OR ANYONE ELSE. `horse_phrase_ledger` already
 *    does this for the social feed (6,121 rows) and it is reused as-is: a
 *    phrase used recently anywhere is not used again, and the same horse never
 *    says the same thing twice.
 *
 * 6. ONE VOICE AT A TIME. A per-table cooldown stops six horses answering the
 *    same pot in the same second, which no table of people does.
 *
 * The phrase pool lives in this file rather than a table on purpose: a
 * `horse_chat_phrases` relation is one more object that could be granted to a
 * player by a later "restore read grants" pass, and this ships only to the
 * engine - never to the client bundle.
 */

import { supabase } from '../services/supabase.js';

/** The moments a person actually says something at a poker table. */
export type TalkMoment = 'won_big' | 'lost_big' | 'showdown' | 'joined';

/**
 * Short, lower-case, poker-native. No emoji (repo rule 5.3), no em dashes, and
 * nothing that reads like a generated sentence: people type three words.
 */
export const TALK_PHRASES: Readonly<Record<TalkMoment, readonly string[]>> = {
  won_big: ['ty', 'thanks', 'ty gg', 'lucky', 'ran good there', 'needed that', 'finally', 'gg'],
  lost_big: [
    'nh',
    'nice hand',
    'wow',
    'brutal',
    'ouch',
    'sick',
    'gg',
    'one time man',
    'cant win those',
    'of course',
  ],
  showdown: ['nh', 'nice', 'good call', 'sick call', 'wow', 'sheesh', 'i had to look', 'nice spot'],
  joined: ['hi all', 'gl all', 'hey', 'gl', 'good luck'],
};

/** Milliseconds. Deliberately generous - a room is quiet most of the time. */
const HORSE_COOLDOWN_MS = 11 * 60 * 1000;
const TABLE_COOLDOWN_MS = 45 * 1000;
/** How long a phrase is off the board once anyone has used it. */
const PHRASE_REUSE_WINDOW_HOURS = 24;

const lastSpokeByHorse = new Map<string, number>();
const lastSpokeByTable = new Map<string, number>();

/** Counters, so a silent failure is visible rather than merely silent. */
export const talkStats = { sent: 0, silenced: 0, unknown: 0, skipped: 0 };

/** FNV-1a. The same derivation the tempo work uses, for the same reason. */
function hash32(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h = (h ^ input.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * How talkative this horse is, forever, from its own id.
 *
 * ~32% never speak, the rest sit between roughly 3% and 22% per eligible
 * moment. A person is either chatty or they are not; it is not a property of
 * the hand they just played.
 */
export function chattiness(horseUserId: string): number {
  const u = (hash32(`talk:${horseUserId}`) >>> 8) / 16777216;
  if (u < 0.32) return 0;
  return 0.03 + (u - 0.32) * 0.28;
}

/** Base odds a moment is worth remarking on at all, before chattiness. */
const MOMENT_WEIGHT: Record<TalkMoment, number> = {
  won_big: 0.55,
  lost_big: 0.7,
  showdown: 0.4,
  joined: 0.35,
};

/**
 * How long a person takes to type it. Log-normal-ish: usually a couple of
 * seconds, occasionally much longer, never instant and never identical.
 */
export function typingDelayMs(rand: () => number = Math.random): number {
  const u = Math.max(1e-6, 1 - rand());
  return Math.round(1200 + -Math.log(u) * 2600);
}

export interface TalkContext {
  tableId: string;
  /** The horse's profile id. It is a player id here, nothing more. */
  userId: string;
  moment: TalkMoment;
  /** Injected in tests. Production passes nothing. */
  now?: number;
  rand?: () => number;
  /** Test seam: schedule instead of really waiting. */
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * Decide whether this horse says something, and if so, say it.
 *
 * Never throws and never blocks the hand: chat is the least important thing
 * happening at a table and must never be able to hold up a pot.
 */
export async function maybeSpeak(ctx: TalkContext): Promise<boolean> {
  const rand = ctx.rand ?? Math.random;
  const now = ctx.now ?? Date.now();
  const schedule = ctx.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref?.());

  const odds = chattiness(ctx.userId) * MOMENT_WEIGHT[ctx.moment];
  if (odds <= 0 || rand() >= odds) {
    talkStats.skipped++;
    return false;
  }

  const horseLast = lastSpokeByHorse.get(ctx.userId) ?? 0;
  const tableLast = lastSpokeByTable.get(ctx.tableId) ?? 0;
  if (now - horseLast < HORSE_COOLDOWN_MS || now - tableLast < TABLE_COOLDOWN_MS) {
    talkStats.skipped++;
    return false;
  }

  // The refusals a human gets. Unknown is not permission.
  let silenced: boolean | null = null;
  try {
    const { data, error } = await supabase.rpc('fn_table_chat_is_silenced', {
      p_table_id: ctx.tableId,
    });
    silenced = error ? null : data === true;
  } catch {
    silenced = null;
  }
  if (silenced === null) {
    talkStats.unknown++;
    return false;
  }
  if (silenced) {
    talkStats.silenced++;
    return false;
  }

  const phrase = await pickPhrase(ctx.userId, ctx.moment, rand);
  if (!phrase) {
    talkStats.skipped++;
    return false;
  }

  // Claim the cooldowns NOW, before the delay, so two moments landing in the
  // same second cannot both pass the check and speak twice.
  lastSpokeByHorse.set(ctx.userId, now);
  lastSpokeByTable.set(ctx.tableId, now);

  schedule(() => {
    void (async () => {
      try {
        const { error } = await supabase.from('table_chat').insert({
          table_id: ctx.tableId,
          user_id: ctx.userId,
          message: phrase,
          message_type: 'player',
        });
        if (error) {
          talkStats.unknown++;
          return;
        }
        talkStats.sent++;
        await supabase
          .from('horse_phrase_ledger')
          .insert({ phrase_norm: phrase, horse_id: ctx.userId, table_id: ctx.tableId });
      } catch {
        talkStats.unknown++;
      }
    })();
  }, typingDelayMs(rand));

  return true;
}

/**
 * A phrase this horse has never said, that nobody has said lately.
 *
 * Reuses `horse_phrase_ledger` exactly as the social feed does. A read that
 * fails returns null rather than a phrase, because repeating yourself in front
 * of the table is worse than staying quiet.
 */
export async function pickPhrase(
  userId: string,
  moment: TalkMoment,
  rand: () => number = Math.random
): Promise<string | null> {
  const pool = TALK_PHRASES[moment];
  if (!pool || pool.length === 0) return null;

  const since = new Date(Date.now() - PHRASE_REUSE_WINDOW_HOURS * 3600 * 1000).toISOString();
  let taken = new Set<string>();
  try {
    const [recent, mine] = await Promise.all([
      supabase.from('horse_phrase_ledger').select('phrase_norm').gte('used_at', since).limit(500),
      supabase.from('horse_phrase_ledger').select('phrase_norm').eq('horse_id', userId).limit(500),
    ]);
    if (recent.error || mine.error) return null;
    taken = new Set([
      ...(recent.data ?? []).map((r: { phrase_norm: string }) => r.phrase_norm),
      ...(mine.data ?? []).map((r: { phrase_norm: string }) => r.phrase_norm),
    ]);
  } catch {
    return null;
  }

  const free = pool.filter((p) => !taken.has(p));
  if (free.length === 0) return null;
  return free[Math.floor(rand() * free.length) % free.length];
}

/** Tests reset the module's memory between cases. */
export function __resetTableTalk(): void {
  lastSpokeByHorse.clear();
  lastSpokeByTable.clear();
  talkStats.sent = 0;
  talkStats.silenced = 0;
  talkStats.unknown = 0;
  talkStats.skipped = 0;
}
