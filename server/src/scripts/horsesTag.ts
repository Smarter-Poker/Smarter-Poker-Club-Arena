/**
 * OPERATION STABLE HAND - Section 7 tagger.
 *
 *   npx tsx src/scripts/horsesTag.ts --club=all
 *   npx tsx src/scripts/horsesTag.ts --club=all --force
 *   npx tsx src/scripts/horsesTag.ts --club=all --dry-run
 *
 * IDEMPOTENT unless --force. Every tag is a pure function of the horse id,
 * the club id and the seed, so a second run without --force writes nothing
 * and a run with --force reproduces byte-identical values. There is no
 * Math.random anywhere in this path.
 *
 * THIS SCRIPT MOVES NO MONEY. It reads `club_members` for identity only and
 * writes exclusively to the two stable_hand_* tables. Section 8.1 seeding is
 * retired (Dan 2026-09-04: use current balances), so there is no funding
 * branch to get wrong.
 */

import { supabase } from '../services/supabase.js';
import { bankrollPolicyFor } from '../services/HorseBankroll.js';
import { fetchAllRows } from '../services/supabase/pagination.js';
import {
  assignTags,
  assignVariants,
  assignPreferredStakes,
  restWeekdayFor,
  dailyCapMinutes,
  tagSplit,
  shDigest,
  STABLE_HAND_SEED,
  JAQK_CLUB_ID,
  SHARK_CLUB_ID,
  DSS_CLUB_ID,
  MIDWAY_UNION_ID,
  hostForWallet,
  type CashPersona,
} from '../services/StableHand.js';

/** The wallets that actually fund cash seats. Midway Union's own 323 horse
 *  memberships are deliberately NOT tagged: zero seats have ever been bought
 *  from that wallet (measured 2026-09-04), and tagging a wallet nothing sits
 *  from would inflate every occupancy denominator. */
const FUNDING_WALLETS = [JAQK_CLUB_ID, SHARK_CLUB_ID, DSS_CLUB_ID];

interface MemberRow extends Record<string, unknown> {
  user_id: string;
  club_id: string;
  /** The wallet this tag is for. `assignPreferredStakes` uses it as the
   *  CEILING on the stakes the horse is tagged for - see Dan's 2026-09-05
   *  ruling in StableHand. Null when the column is unreadable, which the
   *  assignment reads as "no ceiling", exactly as the seat gate reads an
   *  unreadable roll as "no bankroll opinion". */
  chip_balance: number | null;
}

async function loadHorseMemberships(clubIds: string[]): Promise<MemberRow[]> {
  const horses = await fetchAllRows<{ id: string }>(
    (cursor, want) => {
      let q = supabase
        .from('profiles')
        .select('id')
        .eq('is_horse', true)
        .order('id', { ascending: true })
        .limit(want);
      if (cursor) q = q.gt('id', cursor);
      return q;
    },
    { label: 'horsesTag.profiles', maxRows: 50_000, idKey: 'id' }
  );
  if (!horses.complete)
    throw new Error('horse profile read incomplete - refusing to tag a partial fleet');
  const horseIds = new Set(horses.rows.map((r) => r.id));

  const out: MemberRow[] = [];
  for (const clubId of clubIds) {
    const page = await fetchAllRows<MemberRow>(
      (cursor, want) => {
        let q = supabase
          .from('club_members')
          .select('user_id, club_id, chip_balance')
          .eq('club_id', clubId)
          .in('status', ['active', 'approved'])
          .order('user_id', { ascending: true })
          .limit(want);
        if (cursor) q = q.gt('user_id', cursor);
        return q;
      },
      { label: 'horsesTag.members', maxRows: 50_000, idKey: 'user_id' }
    );
    if (!page.complete)
      throw new Error(`membership read incomplete for ${clubId} - refusing to tag a partial fleet`);
    out.push(...page.rows.filter((r) => horseIds.has(r.user_id)));
  }
  return out;
}

export async function runTagger(opts: { force: boolean; dryRun: boolean; clubs: string[] }) {
  const memberships = await loadHorseMemberships(opts.clubs);
  console.log(
    `[stable-hand:tag] ${memberships.length} horse memberships across ${opts.clubs.length} wallet(s)`
  );

  // Tags are per WALLET, so they are computed per club: a body with a JAQK and
  // a Shark wallet is tagged twice, and the two tags are independent.
  const tagRows: Record<string, unknown>[] = [];
  const byClub = new Map<string, MemberRow[]>();
  memberships.forEach((m) => {
    if (!byClub.has(m.club_id)) byClub.set(m.club_id, []);
    byClub.get(m.club_id)!.push(m);
  });

  for (const [clubId, rows] of byClub) {
    const tags = assignTags(
      rows.map((r) => ({ horseId: r.user_id, clubId })),
      STABLE_HAND_SEED
    );
    const cashEligible = tags.filter((t) => t.mode !== 'tourney').map((t) => t.horseId);
    const variants = assignVariants(cashEligible, STABLE_HAND_SEED);

    const split = tagSplit(rows.length);
    const host = hostForWallet(clubId);
    console.log(
      `[stable-hand:tag]   ${clubId} host=${host === MIDWAY_UNION_ID ? 'Midway Union' : 'DSS'} ` +
        `n=${rows.length} cash=${split.cash} tourney=${split.tourney} both=${split.both} freeroll=${split.cashFreeroll}`
    );

    /* THE ROLL IS THE CEILING (Dan, 2026-09-05). The tagger is the only place
       that decides which stakes a horse is ever offered, and until today it
       decided on a hash alone with a ladder that stopped at 1/2 - so no horse
       on the platform was ever tagged above 1/2, however rich, and every 2/5
       and bigger game sat empty. It now reads the same wallet the seat gate
       reads (`club_members.chip_balance` for THIS club) and hands it to
       `assignPreferredStakes` as a ceiling. */
    const rollOf = new Map<string, number>();
    rows.forEach((r) => {
      const bal = Number(r.chip_balance);
      if (Number.isFinite(bal)) rollOf.set(r.user_id, bal);
    });

    for (const t of tags) {
      const isTourneyOnly = t.mode === 'tourney';
      tagRows.push({
        horse_id: t.horseId,
        club_id: t.clubId,
        mode: t.mode,
        cash_freeroll: t.cashFreeroll,
        persona_cash: t.personaCash,
        persona_mtt: t.personaMtt,
        // Section 7.2: a tourney-only horse carries no cash variants.
        variants: isTourneyOnly ? [] : (variants.get(t.horseId) ?? ['nlh']),
        preferred_stakes: isTourneyOnly
          ? []
          : assignPreferredStakes(t.horseId, {
              roll: rollOf.get(t.horseId),
              buyInsToSit: bankrollPolicyFor(t.horseId).buyInsToSit,
            }),
        max_tables: t.maxTables,
        tag_seed: t.tagSeed,
      });
    }
  }

  // ASSERT BEFORE WRITING. A coverage failure means the tagger is wrong, and
  // writing a wrong fleet is worse than writing none.
  const cashTags = tagRows.filter((r) => (r.mode as string) !== 'tourney');
  const covered = (v: string) =>
    cashTags.filter((r) => (r.variants as string[]).includes(v)).length;
  if (cashTags.length > 0 && covered('nlh') < Math.floor(0.65 * cashTags.length)) {
    throw new Error(
      `NLHE coverage ${covered('nlh')}/${cashTags.length} below floor - refusing to write`
    );
  }
  /* SAY WHERE THE FLEET LANDS BEFORE WRITING IT. A tag distribution is the
     single number this script exists to produce, and the 1/2 clamp went
     unnoticed for as long as it did because nothing ever printed it. Bands
     and rungs, cash tags only, and it prints on a dry run too. */
  const bandOfBb = (bb: number) =>
    bb <= 0.5 ? 'micro' : bb <= 2 ? 'low' : bb <= 6 ? 'mid' : 'high';
  const byBand = new Map<string, number>();
  const byRung = new Map<number, number>();
  for (const r of cashTags) {
    const stakes = (r.preferred_stakes as number[]) ?? [];
    const top = stakes.length ? Math.max(...stakes) : 0;
    if (top > 0) byBand.set(bandOfBb(top), (byBand.get(bandOfBb(top)) ?? 0) + 1);
    stakes.forEach((bb) => byRung.set(bb, (byRung.get(bb) ?? 0) + 1));
  }
  console.log(
    `[stable-hand:tag] band of anchor (top preferred stake): ` +
      ['micro', 'low', 'mid', 'high'].map((b) => `${b}=${byBand.get(b) ?? 0}`).join(' ') +
      ` of ${cashTags.length} cash tags`
  );
  console.log(
    `[stable-hand:tag] rungs: ` +
      [...byRung.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bb, n]) => `${bb}=${n}`)
        .join(' ')
  );
  const byVariantBand = new Map<string, Map<string, number>>();
  for (const r of cashTags) {
    const stakes = (r.preferred_stakes as number[]) ?? [];
    const top = stakes.length ? Math.max(...stakes) : 0;
    if (top <= 0) continue;
    for (const v of (r.variants as string[]) ?? []) {
      if (!byVariantBand.has(v)) byVariantBand.set(v, new Map());
      const m = byVariantBand.get(v)!;
      m.set(bandOfBb(top), (m.get(bandOfBb(top)) ?? 0) + 1);
    }
  }
  [...byVariantBand.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([v, m]) =>
      console.log(
        `[stable-hand:tag]   ${v.padEnd(10)} ` +
          ['micro', 'low', 'mid', 'high'].map((b) => `${b}=${m.get(b) ?? 0}`).join(' ')
      )
    );

  console.log(
    `[stable-hand:tag] coverage nlh=${covered('nlh')} plo4=${covered('plo4')} plo5=${covered('plo5')} ` +
      `plo6=${covered('plo6')} pineapple=${covered('pineapple')} short_deck=${covered('short_deck')} ` +
      `plo8=${covered('plo8')} flh=${covered('flh')} flo8=${covered('flo8')} of ${cashTags.length} cash tags`
  );

  // Per-BODY state, one row per unique horse regardless of wallet count.
  const bodies = [...new Set(memberships.map((m) => m.user_id))].sort((a, b) =>
    shDigest(a, STABLE_HAND_SEED).localeCompare(shDigest(b, STABLE_HAND_SEED))
  );
  const personaOf = new Map<string, CashPersona>();
  tagRows.forEach((r) => {
    if (r.persona_cash) personaOf.set(r.horse_id as string, r.persona_cash as CashPersona);
  });
  const today = new Date();
  const stateRows = bodies.map((horseId, i) => {
    const weekday = restWeekdayFor(i);
    return {
      horse_id: horseId,
      rest_weekday: weekday,
      daily_cap_minutes: dailyCapMinutes(personaOf.get(horseId) ?? 'regular', today.getDay()),
    };
  });

  if (opts.dryRun) {
    console.log(
      `[stable-hand:tag] DRY RUN - would write ${tagRows.length} tags and ${stateRows.length} state rows`
    );
    return { tags: tagRows.length, states: stateRows.length, wrote: false };
  }

  /**
   * A PARTIAL RUN IS NOT A FINISHED ONE (2026-09-04).
   *
   * The first real run of this script died on `fetch failed` partway through
   * the first 500-row upsert. Nothing had landed, so nothing was harmed - but
   * the guard here read "any tags at all" as "the fleet is tagged". Had chunk
   * three of four failed instead, the next run would have found 1,500 rows,
   * announced an idempotent no-op, and left 80 horses untagged forever with
   * every log line green.
   *
   * It compares against the number of tags this run intends to write, so a
   * short table is COMPLETED rather than mistaken for a finished one. A table
   * that is longer (a horse left a club, so there are fewer memberships now
   * than rows) is still a no-op - retagging a smaller fleet is what --force is
   * for.
   */
  if (!opts.force) {
    const { count } = await supabase
      .from('stable_hand_membership_tags')
      .select('horse_id', { count: 'exact', head: true });
    if ((count ?? 0) >= tagRows.length) {
      console.log(
        `[stable-hand:tag] ${count} tags already present for ${tagRows.length} memberships - ` +
          `idempotent no-op. Use --force to retag.`
      );
      return { tags: count ?? 0, states: 0, wrote: false };
    }
    if ((count ?? 0) > 0) {
      console.log(
        `[stable-hand:tag] ${count} of ${tagRows.length} tags present - completing a partial run`
      );
    }
  }

  for (let i = 0; i < tagRows.length; i += 500) {
    const chunk = tagRows.slice(i, i + 500);
    const { error } = await supabase
      .from('stable_hand_membership_tags')
      .upsert(chunk, { onConflict: 'horse_id,club_id' });
    if (error) throw new Error(`tag upsert failed: ${error.message}`);
  }

  for (let i = 0; i < stateRows.length; i += 500) {
    const chunk = stateRows.slice(i, i + 500);
    // Never clobber live mutex fields on a retag: only the sticky identity
    // columns are written here. rest_weekday is sticky by OPORD ("do not
    // overwrite if set"), so an existing row keeps the one it has.
    const { error } = await supabase
      .from('stable_hand_horse_state')
      .upsert(chunk, { onConflict: 'horse_id', ignoreDuplicates: !opts.force });
    if (error) throw new Error(`state upsert failed: ${error.message}`);
  }

  /* SAY SO IF IT DID NOT ALL LAND. Every write above throws on an error it
     can see, but a count read back from the table is the only thing that
     proves the fleet is whole. */
  const { count: after } = await supabase
    .from('stable_hand_membership_tags')
    .select('horse_id', { count: 'exact', head: true });
  if ((after ?? 0) < tagRows.length) {
    throw new Error(
      `tagging incomplete: ${after} of ${tagRows.length} tags present after writing - re-run to finish`
    );
  }

  console.log(`[stable-hand:tag] wrote ${tagRows.length} tags, ${stateRows.length} state rows`);
  return { tags: tagRows.length, states: stateRows.length, wrote: true };
}

const isMain = process.argv[1]?.includes('horsesTag');
if (isMain) {
  const argv = process.argv.slice(2);
  const clubArg = argv.find((a) => a.startsWith('--club='))?.split('=')[1] ?? 'all';
  const clubs =
    clubArg === 'all'
      ? FUNDING_WALLETS
      : clubArg === 'jaqk'
        ? [JAQK_CLUB_ID]
        : clubArg === 'shark'
          ? [SHARK_CLUB_ID]
          : clubArg === 'dss'
            ? [DSS_CLUB_ID]
            : [clubArg];
  runTagger({ force: argv.includes('--force'), dryRun: argv.includes('--dry-run'), clubs })
    .then((r) => {
      console.log('[stable-hand:tag] done', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[stable-hand:tag] FAILED', e);
      process.exit(1);
    });
}
