/**
 * THE MINI JACKPOT IS SHOWN THE WAY IT WAS PAID, AND ITS RULES ARE STATED AS
 * THE ENGINE ENFORCES THEM (2026-10-12).
 *
 * D1/D2: fn_bbj_mini_payout stores winner_user_id = the HAND WINNER and
 * loser_user_id = the BAD-BEAT HOLDER (the reverse of the main payout), and
 * never wrote the hand names into bbj_winners. Both readers assumed the main
 * shape, so every mini named the hand winner as the jackpot winner. The
 * migration makes both readers branch on kind and fall back to the payout
 * metadata for a mini's hand names. No payout row is touched.
 *
 * D3: the Mini also requires both hole cards to play in the hold'em family
 * (Dan 2026-10-11), and the per-game bars are Quad Tens for PLO5/FLO5, so
 * "Any Quads (Omaha)" and a hold'em rule without its Ace-in-hand clause were
 * money rules misstated to the player.
 *
 * D4: the main jackpot's announcement is enriched from the newest MAIN payout,
 * never a Mini paid in the same moment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getBBJMiniQualifyingInfo,
  miniBarLabelFor,
  miniBarsPhrase,
  miniBothCardsGamesPhrase,
  miniRequiresBothHoleCards,
} from '../src/config/bbjMini';
import { BBJ_QUALIFYING_HANDS } from '../src/config/RakeConfig';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
/** Comments explain old wording; only code and copy may be judged. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const prose = (src: string) => code(src).replace(/\s+/g, ' ');

const MIGRATIONS = resolve(root, 'supabase/migrations');
const migrationName = readdirSync(MIGRATIONS).find((f) =>
  f.endsWith('_the_mini_jackpot_names_its_bad_beat_holder.sql')
);
const migration = migrationName ? readFileSync(resolve(MIGRATIONS, migrationName), 'utf8') : '';

function fnBlock(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is declared by the migration`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf('$function$;', start);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

const BB_ID =
  /CASE WHEN COALESCE\(p\.kind, 'main'\) = 'mini' THEN p\.loser_user_id ELSE p\.winner_user_id END AS bb_user_id/;
const HW_ID =
  /CASE WHEN COALESCE\(p\.kind, 'main'\) = 'mini' THEN p\.winner_user_id ELSE p\.loser_user_id END AS hw_user_id/;

describe('the mini jackpot names its bad-beat holder (migration)', () => {
  it('exists, is one transaction with a lock timeout, and writes no row', () => {
    expect(migrationName).toBeTruthy();
    expect(migration.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(migration).toMatch(/BEGIN;\s*\n\s*SET LOCAL lock_timeout = '5s';/);
    // Outside the three function bodies there is no DML at all.
    const outside = migration.replace(/AS \$function\$[\s\S]*?\$function\$;/g, '');
    expect(code(outside.replace(/^--.*$/gm, ''))).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i
    );
    expect(migration).toContain('NO PAYOUT ROW IS CHANGED');
  });

  it('refuses to overwrite a definition that moved since it was read', () => {
    for (const fn of ['fn_bbj_recent_hits', 'fn_bbj_hand_detail', 'fn_bbj_mini_payout']) {
      expect(migration).toMatch(
        new RegExp(
          `to_regprocedure\\('public\\.${fn}\\([^']*\\)'\\) AND md5\\(pg_get_functiondef\\(oid\\)\\) = '[0-9a-f]{32}'`
        )
      );
    }
    expect(migration).toContain('BBJ_MINI_DISPLAY_PRIOR_DEFINITION_CHANGED');
    expect(migration).toContain('BBJ_MINI_DISPLAY_NEW_DEFINITION_NOT_IN_FORCE');
  });

  it('fn_bbj_recent_hits reads the bad-beat holder by kind, everywhere it names one', () => {
    const fn = fnBlock('fn_bbj_recent_hits');
    expect(fn).toMatch(BB_ID);
    expect(fn).toMatch(HW_ID);
    expect(fn).toMatch(/WHEN r\.user_id = x\.bb_user_id THEN 'bad_beat'/);
    expect(fn).toMatch(/WHEN r\.user_id = x\.hw_user_id THEN 'hand_winner'/);
    expect(fn).toContain('LEFT JOIN public.profiles bb ON bb.id = x.bb_user_id');
    expect(fn).toContain('LEFT JOIN public.profiles hw ON hw.id = x.hw_user_id');
    expect(fn).toContain('x.hole_cards -> (x.bb_user_id::text)');
    // Nothing still reads a role or a player straight off winner/loser.
    expect(fn).not.toMatch(/r\.user_id = x\.(winner|loser)_user_id/);
    expect(fn).not.toMatch(/profiles (bb|hw) ON \w+\.id = x\.(winner|loser)_user_id/);
    // A mini's hands fall back to the metadata the engine always sent.
    expect(fn).toMatch(
      /THEN COALESCE\(NULLIF\(w\.loser_hand, ''\), NULLIF\(NULLIF\(p\.metadata->>'loser_hand'/
    );
    expect(fn).toMatch(
      /THEN COALESCE\(NULLIF\(w\.winner_hand, ''\), NULLIF\(NULLIF\(p\.metadata->>'winner_hand'/
    );
    // and its names come from the other bbj_winners column.
    expect(fn).toMatch(
      /THEN w\.loser_display_name ELSE w\.winner_display_name END AS bb_display_name/
    );
    // The signature and the filter the Mini tab relies on are unchanged.
    expect(fn).toContain('p_kind text DEFAULT NULL::text');
    expect(fn).toContain("(p_kind IS NULL OR COALESCE(p.kind, 'main') = p_kind)");
  });

  it('fn_bbj_hand_detail reads the bad-beat holder by kind, including a pruned hand', () => {
    const fn = fnBlock('fn_bbj_hand_detail');
    expect(fn).toMatch(BB_ID);
    expect(fn).toMatch(HW_ID);
    expect(fn).toContain("WHEN r.user_id = (SELECT bb_user_id FROM pay) THEN 'bad_beat'");
    expect(fn).toContain("WHEN r.user_id = (SELECT hw_user_id FROM pay) THEN 'hand_winner'");
    expect(fn).toMatch(/'badBeatUserId',\s+\(SELECT bb_user_id FROM pay\)/);
    expect(fn).toMatch(/'handWinnerUserId',\s+\(SELECT hw_user_id FROM pay\)/);
    expect(fn).not.toMatch(/\(SELECT (winner|loser)_user_id\s+FROM pay\)/);
    expect(fn).toMatch(
      /'badBeatName',\s+\(SELECT COALESCE\(NULLIF\(CASE WHEN COALESCE\(pay\.kind, 'main'\) = 'mini' THEN w\.loser_display_name ELSE w\.winner_display_name END/
    );
    expect(fn).toMatch(/'badBeatHand',[\s\S]*?pay\.metadata->>'loser_hand'/);
    expect(fn).toMatch(/'handWinnerHand',[\s\S]*?pay\.metadata->>'winner_hand'/);
  });

  it('fn_bbj_mini_payout writes the hand names and changes nothing else it stores', () => {
    const fn = fnBlock('fn_bbj_mini_payout');
    expect(fn).toMatch(
      /winner_display_name, loser_display_name, kind,\s*winner_hand, loser_hand\)/
    );
    expect(fn).toMatch(
      /v_winner_name, v_loser_name, 'mini',\s*NULLIF\(p_metadata->>'winner_hand', ''\), NULLIF\(p_metadata->>'loser_hand', ''\)\)/
    );
    // The stored convention is NOT flipped: winner_user_id is still the hand winner.
    expect(fn).toContain(
      'VALUES (p_pool_id, v_hand_id, p_table_id, p_hand_number, p_winner_user_id, p_loser_user_id,'
    );
    // Money logic and idempotency are the ones it had.
    expect(fn).toContain('v_loser  := round(v_total * 0.50, 2);');
    expect(fn).toContain('ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING;');
    expect(fn).toContain("fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id");
  });
});

describe('the mini bars are stated as the engine enforces them', () => {
  it('both hole cards play in the hold’em family only', () => {
    for (const k of ['nlh', 'flh', 'pineapple']) expect(miniRequiresBothHoleCards(k)).toBe(true);
    for (const k of ['plo4', 'plo8', 'flo8', 'plo5', 'flo5']) {
      expect(miniRequiresBothHoleCards(k)).toBe(false);
    }
    expect(getBBJMiniQualifyingInfo('nlh').subLabel).toMatch(/Both hole cards must still play/);
    expect(getBBJMiniQualifyingInfo('pineapple').subLabel).toMatch(/Both hole cards must play\./);
    for (const k of ['plo5', 'flo5', 'plo4', 'plo8']) {
      expect(getBBJMiniQualifyingInfo(k).subLabel).not.toMatch(/[Bb]oth hole cards/);
    }
  });

  it('the bar phrase is read from the bars, per game', () => {
    expect(miniBarsPhrase()).toBe(
      'Aces Full Or Better In Hold’em, Quad Deuces Or Better In Pineapple, Any Quads In PLO4, FLO4, PLO8 And FLO8, And Quad Tens Or Better In PLO5 And FLO5'
    );
    expect(miniBothCardsGamesPhrase()).toBe('Hold’em And Pineapple');
    expect(miniBarLabelFor('plo6')).toBeNull();
    expect(miniBarLabelFor('short_deck')).toBeNull();
    expect(miniBarLabelFor('plo5')).toBe(BBJ_QUALIFYING_HANDS.plo5.miniBarLabel);
  });

  it('every mini surface says both hole cards must play', () => {
    for (const f of [
      'src/components/bbj/BBJRulesPanel.tsx',
      'src/components/bbj/BBJBasicPanel.tsx',
      'src/components/bbj/BBJMiniPanel.tsx',
    ]) {
      expect(prose(read(f)), f).toMatch(/In Hold’em And Pineapple, Both Hole Cards Must Play/);
    }
    // The rules page's per-game table carries it on the hold'em-family rows.
    expect(read('src/components/bbj/BBJRulesPanel.tsx')).toMatch(
      /miniRequiresBothHoleCards\(row\.key\)[\s\S]{0,120}Both Hole Cards Must Play/
    );
  });

  it('the empty Mini winners list reads its bars from the config and never says "Any Quads (Omaha)"', () => {
    const hits = read('src/components/bbj/BBJRecentHits.tsx');
    expect(prose(hits)).not.toMatch(/Any Quads \(Omaha\)/);
    expect(hits).toContain('{miniBarsPhrase()}');
    expect(hits).toContain('{miniBothCardsGamesPhrase()}');
    expect(prose(hits)).toMatch(/Both Hole Cards Must Play/);
  });

  it('the FAQ states the hold’em Ace-in-hand rule, the real Omaha bars and the Mini', () => {
    const faq = prose(read('src/components/support/FAQPanel.tsx'));
    const answer = faq.match(/How Does Bad Beat Jackpot Work\?',\s*answer:\s*'([^']*)'/)?.[1] ?? '';
    expect(answer).toMatch(/Aces Full Of Jacks Or Better/);
    expect(answer).toMatch(/An Ace In Your Hand/);
    expect(answer).toMatch(/Both Hole Cards Playing/);
    expect(answer).toMatch(/PLO5 And FLO5, An 8-High Straight Flush Or Better Must Lose/);
    expect(answer).not.toMatch(/In Omaha Games, Quad Kings/);
    expect(answer).toMatch(/PLO6 And Short Deck Have No Jackpot/);
    expect(answer).toMatch(/The Mini Jackpot/);
    for (const k of ['pineapple', 'plo5']) {
      expect(answer).toContain(BBJ_QUALIFYING_HANDS[k].miniBarLabel as string);
    }
    expect(answer).not.toContain('—');
  });
});

describe('the main announcement is enriched from a main payout', () => {
  it('asks fn_bbj_recent_hits for p_kind main', () => {
    expect(read('src/lib/bbjHitFeed.ts')).toMatch(
      /rpc\('fn_bbj_recent_hits', \{\s*p_pool_id: poolId,\s*p_limit: 1,\s*p_kind: 'main',\s*\}\)/
    );
  });
});
