/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HORSE IS NEVER THE REASON A PLAYER IS NOT PAID
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Extends the horses-are-players law (CLAUDE.md 10.5, tests/horses-are-players
 * .test.ts and scripts/ci/check-horses-are-players.mjs) to the one place those
 * two never looked: the SQL that moves or settles money by hand.
 *
 * Dan, 2026-08-27, binding: "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON
 * ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!" A horse IS
 * PAID everything a human is paid - "Never 'skip the horses' on a repayment" -
 * and CLAUDE.md 10.9 rule 3: nothing is taken back from a player for our
 * mistake.
 *
 * WHY THIS EXISTS (2026-09-26). Three migrations applied to production that
 * morning without a pull request used horse status as the reason:
 *   20260926092115  took 1,001.00 back from 32 wallets, on the rule "a
 *                   duplicate paid to a HORSE is recovered; a duplicate paid
 *                   to a human is never clawed back", guarded in code by
 *                   `p.is_horse IS NOT TRUE -> RAISE`;
 *   20260926092142  closed PKO 3f19bd70's 1,355.00 shortfall "NOTHING PAID.
 *                   Every entrant was a house-operated horse";
 *   20260926093159  closed a week of cash rakeback "without payment" because
 *                   "every recipient is a house horse".
 * Each header claimed Dan had delegated the decision. Dan ruled all three
 * reversed; 20260926131530 returned the 1,001.00 and 20260926131420 reopened
 * the two owed amounts. The two text gates above scan TypeScript for `!isHorse`
 * and could not have seen any of it.
 *
 * WHAT IT REFUSES, in every migration from 2026-09-26 on:
 *   1. CODE: the SQL (comments stripped) reads `is_horse` AND takes money from
 *      a player or closes an owed item - a player-wallet debit, a
 *      prize_reversal debit, a negative 10.9 adjustment, a clawback, an alert
 *      or obligation resolved/closed/retired/written off.
 *   2. TEXT: a string the SQL writes into a row reasons that a group of
 *      recipients/entrants/players were horses to justify closing, not paying
 *      or recovering.
 * WHAT IT KEEPS PASSING - the two uses 10.5 allows:
 *   IDENTIFICATION  reading or surfacing the flag as data (a report column, a
 *                   badge, a roster field), with no take-back or closure;
 *   INPUT DEVICE    the plumbing that creates, seats, funds and steers the
 *                   fleet (fn_seed_horses_to_floor, autoRebuyHorse, a horse
 *                   rebuy) - it gives a horse what a browser would, it never
 *                   takes anything away.
 *
 * THE THREE FILES ABOVE are on main as byte-identical recordings of what
 * production ran. They are history, not proposals, and they stay flagged: the
 * register below exempts each ONLY while the migration that reversed it is
 * present beside it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIG_DIR = join(ROOT, 'supabase/migrations');

/** The first version this law binds. Everything earlier predates the incident. */
export const BINDS_FROM = '20260926000000';

/** Recorded history that broke the law, each with the migration that reversed it. */
const REVERSED_HISTORY: Record<string, { reversedBy: string[]; what: string }> = {
  '20260926092115': {
    reversedBy: ['20260926131530', '20260926131420'],
    what: 'clawed 1,001.00 back from 32 horse wallets; returned by 131530, verified by 131420',
  },
  '20260926092142': {
    reversedBy: ['20260926131420'],
    what: 'closed 3f19bd70 1,355.00 unpaid because the field were horses; reopened by 131420',
  },
  '20260926093159': {
    reversedBy: ['20260926131554', '20260926131420'],
    what: 'closed the week of 2026-09-14 rakeback unpaid because recipients were horses; voided by 131554, reopened by 131420',
  },
};

/** Strip SQL comments but keep string literals intact. */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (inStr) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        inStr = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = dollarTag === m[0] ? null : (dollarTag ?? m[0]);
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The string literals a statement writes, '' unescaped. */
export function stringLiterals(code: string): string[] {
  const lits: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) lits.push(m[1].replace(/''/g, "'"));
  return lits;
}

const HORSE_PREDICATE = /\bis_horse\b/i;

/** Taking money back from a player, in code. */
const TAKE_BACK: RegExp[] = [
  /chip_balance\s*=\s*chip_balance\s*-/i, // a wallet debit
  /'debit'\s*,\s*'prize_reversal'/i, // a prize reversal receipt
  /fn_ca_adjustment_under_10_9\s*\([^;]*?,\s*-\s*[\w.]*amount/i, // a negative 10.9 adjustment
  /claw_?back/i,
];

/** Closing an owed item, in code. */
const CLOSE_OWED: RegExp[] = [
  /\bresolved\s*=\s*true\b/i,
  /closed_(?:without|no)_payment/i,
  /\bterminal_closed_at\s*=/i,
  /tournament_obligation_retirements/i,
  /UPDATE\s+public\.accounting_deferred_obligations/i,
];

/**
 * Paying a player, in code. A file that credits players and then resolves the
 * alerts it paid is writing receipts, not closing anything unpaid - the
 * 2026-09-26 mystery-bounty make-good (085132) is exactly that shape.
 */
const PAYS: RegExp[] = [
  /chip_balance\s*=\s*chip_balance\s*\+/i,
  /'credit'\s*,\s*'(?:prize|bounty|refund|settlement|rakeback|prize_reversal|promotion)'/i,
  /fn_credit_and_log\s*\(/i,
];

/** A written reason: a group were horses, therefore closed / unpaid / recovered. */
const HORSE_GROUP =
  /\b(?:every|all)\b[^.;]{0,80}?\b(?:recipients?|entrants?|players?|finishers?|winners?|payees?|field)\b[^.;]{0,80}?\bhorses?\b/i;
const DENIAL_WORD =
  /\b(?:closed?|without payment|nothing (?:is )?(?:paid|owed)|not paid|unpaid|recover(?:ed|y)?|clawed|written off|write-off|no human is (?:owed|short))\b/i;
/** A sentence that names that reasoning in order to reject it is not the reasoning. */
const REJECTS_IT =
  /\b(?:forbids?|forbidden|void(?:ed)?|revers(?:e|ed|al)|supersed(?:e|ed|es)|ruled|10\.5)\b/i;

/** Code with every string literal blanked, so a note like "no clawback" is not an action. */
function codeOnly(code: string): string {
  return code.replace(/'(?:[^']|'')*'/g, "''");
}

export type Finding = { rule: 'code' | 'text'; detail: string };

export function horseDenials(sql: string): Finding[] {
  const code = stripSqlComments(sql);
  const bare = codeOnly(code);
  const findings: Finding[] = [];
  if (HORSE_PREDICATE.test(bare)) {
    const takes = TAKE_BACK.filter(
      (re) => re.test(code) && (re.source.includes("'") || re.test(bare))
    );
    const pays = PAYS.some((re) => re.test(code));
    const closes = pays ? [] : CLOSE_OWED.filter((re) => re.test(bare));
    const hits = [...takes, ...closes];
    if (hits.length > 0) {
      findings.push({
        rule: 'code',
        detail: `reads is_horse and ${hits.map((r) => r.source).join(' + ')}`,
      });
    }
  }
  for (const lit of stringLiterals(code)) {
    for (const sentence of lit.split(/(?<=[.;])\s+/)) {
      if (HORSE_GROUP.test(sentence) && DENIAL_WORD.test(sentence) && !REJECTS_IT.test(sentence)) {
        findings.push({ rule: 'text', detail: sentence });
      }
    }
  }
  return findings;
}

const version = (f: string) => f.slice(0, 14);
const migrations = () =>
  readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql') && /^\d{14}_/.test(f))
    .sort();

describe('a horse is never the reason a player is not paid', () => {
  it('no migration since the incident uses horse status to take money back or close what is owed', () => {
    const offenders: string[] = [];
    for (const f of migrations()) {
      const v = version(f);
      if (v < BINDS_FROM || REVERSED_HISTORY[v]) continue;
      const found = horseDenials(readFileSync(join(MIG_DIR, f), 'utf8'));
      for (const x of found) offenders.push(`${f} [${x.rule}] ${x.detail}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the recorded history that broke it still reads as broken, and each is exempt only beside its reversal', () => {
    for (const [v, entry] of Object.entries(REVERSED_HISTORY)) {
      const file = migrations().find((f) => version(f) === v);
      expect(file, `${v} is recorded on main`).toBeTruthy();
      const found = horseDenials(readFileSync(join(MIG_DIR, file!), 'utf8'));
      expect(found.length, `${v} (${entry.what}) must still be detected`).toBeGreaterThan(0);
      for (const r of entry.reversedBy) {
        expect(
          migrations().some((f) => version(f) === r),
          `${v} is exempt only while its reversal ${r} is present`
        ).toBe(true);
      }
    }
  });

  it('the register cannot grow into a pardon: only the three reversed files are in it', () => {
    expect(Object.keys(REVERSED_HISTORY).sort()).toEqual([
      '20260926092115',
      '20260926092142',
      '20260926093159',
    ]);
  });
});

describe('the scanner itself', () => {
  it('flags the clawback rule of 20260926092115 re-planted in a new file', () => {
    const planted = `
      BEGIN;
      DO $mig$ BEGIN
        IF EXISTS (SELECT 1 FROM zz_dup d LEFT JOIN public.profiles p ON p.id = d.user_id WHERE p.is_horse IS NOT TRUE) THEN
          RAISE EXCEPTION 'a recipient is not a horse; a human is never clawed back';
        END IF;
        UPDATE public.club_members SET chip_balance = chip_balance - r.amount WHERE user_id = r.user_id;
        PERFORM public.log_wallet_transaction(r.user_id, 'PLAYER', r.amount, 'debit', 'prize_reversal', 'x', NULL, NULL, NULL);
      END $mig$;
      COMMIT;`;
    expect(horseDenials(planted).map((f) => f.rule)).toContain('code');
  });

  it('flags a closure that reasons "every recipient is a horse", even without is_horse in the code', () => {
    const planted = `UPDATE public.financial_alerts SET resolved = true,
      resolution = 'Closed without payment. Every recipient is a house horse, so no human is owed.'
      WHERE source = 'x';`;
    expect(horseDenials(planted).map((f) => f.rule)).toContain('text');
  });

  it('flags a horse-only field closed as nothing paid', () => {
    const planted = `UPDATE public.financial_alerts SET resolved = true, resolution =
      'Disposition recorded, nothing paid. All 66 entrants were house-operated horses, so no human is short.' WHERE id = 'x';`;
    expect(horseDenials(planted).length).toBeGreaterThan(0);
  });

  it('keeps IDENTIFICATION passing: the flag read as data, nothing taken, nothing closed', () => {
    const ok = `CREATE OR REPLACE FUNCTION public.fn_roster(p uuid) RETURNS TABLE(user_id uuid, is_horse boolean)
      LANGUAGE sql AS $f$ SELECT tp.user_id, pr.is_horse FROM public.tournament_players tp
      JOIN public.profiles pr ON pr.id = tp.user_id WHERE tp.tournament_id = p $f$;`;
    expect(horseDenials(ok)).toEqual([]);
  });

  it('keeps the INPUT DEVICE passing: seating and funding the fleet', () => {
    const ok = `CREATE OR REPLACE FUNCTION public.fn_seed_horses_to_floor(p_club uuid) RETURNS int LANGUAGE plpgsql AS $f$
      BEGIN
        INSERT INTO public.table_seats(table_id, user_id, stack)
        SELECT t.id, p.id, t.min_buyin FROM public.profiles p, public.tables t WHERE p.is_horse AND t.club_id = p_club;
        UPDATE public.club_members SET chip_balance = chip_balance + 100 WHERE user_id IN (SELECT id FROM public.profiles WHERE is_horse);
        RETURN 1;
      END $f$;`;
    expect(horseDenials(ok)).toEqual([]);
  });

  it('does not flag a migration that quotes the forbidden reasoning only in comments to reverse it', () => {
    const ok = `-- 092142 closed it: "CLOSED, NOTHING PAID. Every entrant was a house-operated horse".
      -- That is reversed here.
      UPDATE public.financial_alerts SET resolved = false, resolution = NULL WHERE id = 'x';`;
    expect(horseDenials(ok)).toEqual([]);
  });

  it('does not flag a payment that reads the flag and then resolves the alerts it paid', () => {
    const ok = `DO $m$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = r.user_id AND p.is_horse IS TRUE) THEN
          RAISE EXCEPTION 'payee changed; read it again';
        END IF;
        UPDATE public.club_members SET chip_balance = chip_balance + r.amount WHERE user_id = r.user_id;
        UPDATE public.financial_alerts SET resolved = true, resolution = 'Paid. The overpayments stand (no clawback).' WHERE id = r.alert_id;
      END $m$;`;
    expect(horseDenials(ok)).toEqual([]);
  });

  it('does not flag a sentence that names the horse reasoning in order to void it', () => {
    const ok = `UPDATE public.accounting_deferred_obligations SET reason = reason ||
      'The write-off is VOID. It rested on every recipient being a horse, which CLAUDE.md 10.5 forbids, so nothing is written off.'
      WHERE scope_id = 'x';`;
    expect(horseDenials(ok)).toEqual([]);
  });

  it('is scoped from the incident on, and the cutoff cannot be moved forward silently', () => {
    expect(BINDS_FROM).toBe('20260926000000');
    expect(existsSync(MIG_DIR)).toBe(true);
  });
});
