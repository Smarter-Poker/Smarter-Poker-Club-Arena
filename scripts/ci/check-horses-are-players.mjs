#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  check-horses-are-players — every place a horse is treated differently, on purpose
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-27, BINDING: "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON
 * ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!"
 * (World Hub CLAUDE.md section 10.5.)
 *
 * ── WHY A GATE, WHEN THE LAW IS ONE DAY OLD ────────────────────────────────
 *
 * Because its first fix was already inert when it was written.
 *
 * The law removed a horse-only predicate from `fn_nit_evictions` so the fleet
 * could be stood up by the VPIP rule like anybody else, and left a comment
 * saying "fn_nit_check's own sample floor spares a short sample, horses
 * included". But the rule is judged from `ca_hand_facts`, and the engine wrote
 * that table for humans only - so a horse's sample was not short, it was
 * permanently EMPTY, and `0 >= 100` is false. Every horse returned
 * `within_limits` for ever.
 *
 * Proved against production on 2026-08-27 in a rolled-back transaction: with
 * NIT Game demanding a 99% VPIP, the human was evicted on 24.6% over 544 hands
 * and the horse beside them came back `ok: true`. Fixing one end of a rule and
 * assuming the other end agrees is exactly the failure this gate is for.
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 * Finds every place the horse flag CHANGES BEHAVIOUR in the client and the
 * engine (`!p.isHorse`, `is_horse === false`) and holds it against the
 * register below.
 *
 * It deliberately does not try to guess which way a given negation cuts:
 * `if (!seated?.is_horse) continue` EXCLUDES horses in one file and SELECTS
 * them in another, and a script that guessed would eventually guess wrong
 * about a rule that decides whether a player is thrown out of a game. So it
 * surfaces every site and asks a person to have written down which it is.
 *
 * The register is the point. Each entry is a claim, in writing, that the
 * difference is one of the two things the law still allows:
 *
 *   IDENTIFICATION   surfacing the flag as data, or the plumbing that creates,
 *                    seats, funds and steers the fleet;
 *   EQUAL OUTCOME    the horse reaches the same place by another road. The
 *                    test is never "did it run the same code", it is "did it
 *                    get the same outcome".
 *
 * A new exclusion, anywhere, fails the build until somebody writes down which
 * of those two it is. That is a deliberately small amount of friction placed
 * exactly where this law gets broken: by an agent adding one more `!isHorse`
 * because it looked tidy.
 *
 * Counts, not line numbers, so ordinary edits above a line do not fail CI.
 *
 * Run:  node scripts/ci/check-horses-are-players.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const ROOTS = ['src', 'server/src'];
const EXTS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '_to_delete', '__tests__', 'test-results']);

/**
 * Excluding shapes only. `!!p.is_horse` is a coercion and `isHorse: x` is a
 * field, and neither denies a horse anything, so neither is matched.
 */
const EXCLUDE = [
  /(?<!!)!\s*[\w.?]*\bis_?[Hh]orse\b/, //  !p.isHorse   /  !p.is_horse
  /\bis_?[Hh]orse\s*={2,3}\s*false\b/, //  is_horse === false
  /\bis_?[Hh]orse\s*!={1,2}\s*true\b/, //  isHorse !== true
];

/**
 * THE REGISTER. file -> { allowed, kind, why }
 *
 * `allowed` is how many excluding predicates that file may contain. Raising a
 * number, or adding a file, is the moment to prove the difference is
 * identification or an equal outcome - and to say so here.
 */
const REGISTER = {
  'src/pages/club/ClubDataPage.tsx': {
    allowed: 1,
    kind: 'IDENTIFICATION',
    why: [
      'An operator-controlled "Hide Horses" chip on the club data page\'s Players tab. Same shape as the leaderboard toggle below, and it passes the same test: it defaults to SHOWING horses (useState(false)), which is what the law requires of anything opt-in.',
      '',
      'It changes what an operator is LOOKING AT and nothing about what a horse receives. Nothing downstream reads it - not the rake, not an agent\'s commission, not a settlement. The horse is neither paid less nor seated differently because somebody unticked a box on a reporting page.',
      '',
      'And the page refuses to let the filter lie about the total. With the chip on, the summary beside the list is recomputed from the filtered rows and RELABELS itself from "Players" to "People", so a scoped figure can never be read as the club\'s. Leaving the unfiltered total under a filtered list would have been the actual bug here.',
    ].join('\n'),
  },
  'src/utils/clubDashboard.ts': {
    allowed: 1,
    kind: 'IDENTIFICATION',
    why: 'A player-controlled "hide horses" toggle on the club leaderboard. It defaults to SHOWING horses (ClubDashboard reads ca_dashboard_hide_horses with a false default), which is what the law requires of anything opt-in, and the leaderboard itself is fed by ca_club_top_players, which counts horses in full (286,589 horse rows in club_member_daily_stats against 60 human ones).',
  },
  'server/src/engine/ServerTableEngineBase.ts': {
    allowed: 1,
    kind: 'EQUAL OUTCOME',
    why: 'humansSeated() drives the DEPLOY DRAIN gate: a server push restarts engines and voids the hand in flight. Chips are preserved either way, so nothing is taken from the horse; and because this platform is horse-heavy, counting horses here would mean no deploy could ever drain, which is an outage, not equal treatment. Raised for Dan in the 2026-08-27 audit.',
  },
  'server/src/engine/ServerTableEngineDealing.ts': {
    allowed: 3,
    kind: 'IDENTIFICATION',
    why: [
      'ALL THREE are the horse INPUT DEVICE, which is the law\'s second sanctioned exemption, and in each the horse ends up BETTER served than a human rather than worse.',
      '',
      '(0) the V48 voluntary straddle round - `if (!seated?.is_horse) continue`. A human enrolls in the voluntary straddle by clicking the table setting, which reaches toggleAutoStraddle through the seating route. A horse has no browser, so the engine supplies the same click from its persona before the straddle round. The loop only ever calls toggleAutoStraddle FOR A HORSE; a human\'s own enrollment is never read, written or overridden by it. Removing the guard would have the engine overwriting every human\'s straddle setting every hand, which is the actual bug this line prevents.',
      '',
      '(1) anyBustedPlayerCanAffordARebuy - `const humans = busted.filter(p => !p.is_horse)`. This decides whether the felt holds five seconds for a bust, and it decides it by reading club_members.chip_balance. A horse HAS no member wallet: it is funded from the club treasury through autoRebuyHorse/fn_horse_fund_from_treasury. Asking the wrong ledger about a horse would answer "cannot afford" and DENY it the pause. So the horse is asked its own question first, immediately above, and any horse below its two-rebuy stop-loss returns true - the pause is granted before a single wallet is read. A horse can therefore only ever gain a pause from this branch, never lose one.',
      '',
      '(2) standUpBustedCashPlayers - `const seated = this.seatedPlayers.filter(p => p.user_id && !p.is_horse)`. Busted horses are removed by recoverBustedSeatedHorses(), which runs on the SAME tick a few lines above this and is strictly more generous: it retries a treasury rebuy every 30s and only stands the horse up at stop-loss or on an empty treasury. Including horses here would let this sweep remove a horse DURING that 30s throttle, before its next funding attempt - taking a rebuy away that a human in the same position would have kept. The exclusion is what makes the two equal; removing it would be the bug.',
      '',
      'Neither branch withholds anything a human receives. Both were added 2026-08-28 with the busted-seat release (Dan: "make sure that the user gets removed from the table as soon as they have no chips"), which until then existed for horses and not for humans at all.',
    ].join('\n'),
  },
  'server/src/engine/ServerTableEngineSettlement.ts': {
    allowed: 2,
    kind: 'IDENTIFICATION',
    why: [
      '(1) Horse cash-out plumbing: picks the horses that have hit their deterministic stack target and stands them up on their big blind. Fleet steering, and it denies a horse nothing.',
      '',
      '(2) horsesTakeABreather (V48, 2026-09-06) - the INPUT DEVICE exemption, the same one the voluntary straddle round carries in ServerTableEngineDealing. A human who loses a buy-in in one hand can click Sit Out; a horse has no browser, so this reads is_horse to find the seats that need the click made for them. It calls the SAME public sitOut() the button calls, so every rule that governs a human sitting out governs this: the play-one-hand gate, the disconnect engine, the eviction clock. It withholds nothing - it GRANTS a horse a behaviour only humans had.',
    ].join('\n'),
  },
  'server/src/handlers/faultInjection.ts': {
    allowed: 1,
    kind: 'EQUAL OUTCOME',
    why: 'Refuses a chaos DRILL on any table with a real person at it. Drills are deliberate damage; declining to inflict it on humans is not a benefit withheld from horses.',
  },
  'server/src/services/supabase/handHistory.ts': {
    allowed: 1,
    kind: 'IDENTIFICATION',
    why: 'Sets has_human, which sp_prune_hand_history reads to spare human hands from the 7 day purge. Retention is a STORAGE policy, and the law explicitly leaves that knob to Dan rather than to an agent: hand_history is 3.6 GB over 1.57M hands and grows ~221k hands a day.',
  },
  'server/src/services/supabase/handFacts.ts': {
    allowed: 1,
    kind: 'EQUAL OUTCOME',
    why: 'Fact rows are written for humans everywhere, and for horses at NIT tables - so the VPIP rule and the evidence it is judged on cover the same seats (fixed 2026-08-27; before that the rule could not bite a horse at all). Not switched on for horses platform-wide because that is ~1.3M rows a day, which is the same storage decision as retention and is Dan\'s to make.',
  },
  'server/src/engine/ServerTableEngineRunout.ts': {
    allowed: 2,
    kind: 'IDENTIFICATION',
    why: 'Horse-ONLY paths, where the negation SELECTS horses rather than excluding them: scheduling a horse\'s pineapple discard, and its insurance response. Both hand a horse a feature it would otherwise sit out of, which is the opposite of an exclusion.',
  },
  'server/src/services/HorseHandReview.ts': {
    allowed: 2,
    kind: 'IDENTIFICATION',
    why: 'Horse-ONLY again: writes the per-hand leak review rows for the fleet, and (2026-09-05) touches ca_horse_fleet_state - a table that has a row per horse and none per human - with the settlement time. Horses get MORE here than humans do, not less.',
  },
};

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (EXTS.has(extname(entry))) acc.push(full);
  }
  return acc;
}

const found = {}; // file -> [{ line, text }]

for (const r of ROOTS) {
  let files = [];
  try {
    files = walk(join(ROOT, r));
  } catch {
    continue; // a root that does not exist in this checkout
  }
  for (const file of files) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return; // comments never run
      if (EXCLUDE.some((re) => re.test(line))) {
        (found[rel] ||= []).push({ line: idx + 1, text: t.slice(0, 110) });
      }
    });
  }
}

const problems = [];

for (const [file, hits] of Object.entries(found)) {
  const entry = REGISTER[file];
  if (!entry) {
    problems.push({
      file,
      kind: 'UNREGISTERED',
      hits,
      msg: 'excludes horses and is not in the register',
    });
  } else if (hits.length > entry.allowed) {
    problems.push({
      file,
      kind: 'GREW',
      hits,
      msg: `has ${hits.length} horse exclusions, the register allows ${entry.allowed}`,
    });
  }
}

// A register entry whose file no longer excludes anything is stale - say so,
// but do not fail: deleting an exclusion is the outcome this gate wants.
const stale = Object.keys(REGISTER).filter((f) => !found[f]);

if (problems.length > 0) {
  console.error('\ncheck-horses-are-players FAILED\n');
  console.error('Dan 2026-08-27 (binding): "HORSES ARE NEVER EVER DISCLUDED BY DESIGN');
  console.error('ON ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!"\n');
  for (const p of problems) {
    console.error(`  ${p.file} ${p.msg}:`);
    for (const h of p.hits) console.error(`      ${h.line}: ${h.text}`);
  }
  console.error('\nIf a horse ends up WORSE OFF than a human, it is a bug - fix it.');
  console.error('If the difference is identification, or the horse reaches the same');
  console.error('outcome another way, add the file to REGISTER in this script and');
  console.error('write down which of the two it is and why.\n');
  process.exit(1);
}

if (stale.length > 0) {
  console.log(`check-horses-are-players: OK - ${stale.length} register entry(s) now unused:`);
  for (const f of stale) console.log(`    ${f} (exclusion gone - drop it from REGISTER)`);
} else {
  console.log(
    `check-horses-are-players: OK - ${Object.keys(found).length} registered exclusion(s), all justified.`
  );
}
