/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND TOURNAMENT DOOR ANSWERS THE CLIENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 8 of the Diamond Arena programme, last database piece. The money is
 * where it belongs (entry is custody; the event pays from it); this makes the
 * doors answer the way the client already reads:
 *
 *   1. fn_poker_arena_context reports the tournament switch beside the cash
 *      switch, so the lobby can say "Not Open Yet" instead of offering a
 *      Register the server refuses.
 *   2. The registration core answers an ordinary Diamond refusal with
 *      {ok:false, reason} - not enough settled Diamonds, the door closed, an
 *      unsettled debt, an entry already held - exactly as it answers a chip
 *      refusal, and re-raises everything else. Its success receipt names the
 *      asset and the Diamond wallet after the charge.
 *   3. The Diamond unregistration receipt carries the wallet after the refund.
 *
 * Every edit is in place with the live md5 pinned and the reverse substitution
 * proved; the chip debit is asserted still present at the end; the door is
 * never opened.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_tournament_door_answers_the_client.sql'))
  .at(-1);
if (!NAME) throw new Error('the tournament-door migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const CONTEXT = section('-- 1. THE ARENA CONTEXT', '-- 2. THE REGISTRATION CORE');
const REGISTRATION = section(
  '-- 2. THE REGISTRATION CORE',
  '-- 3. THE DIAMOND UNREGISTRATION RECEIPT'
);
const UNREGISTER = section(
  '-- 3. THE DIAMOND UNREGISTRATION RECEIPT',
  '-- 4. THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 4. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});

describe('LAW: a Diamond tournament door answers the client', () => {
  it('opens nothing', () => {
    expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
    expect(code(MIG)).toMatch(/expects it closed/);
    expect(FINAL).toContain('this migration must not open the tournament door');
  });

  it('the arena context reports the tournament switch the way it reports the cash switch', () => {
    expect(pinnedEdits(CONTEXT)).toEqual({ pins: 1, reversals: 1 });
    expect(CONTEXT).toContain("'6e086d02da060e50d118e0a08cd49452'");
    expect(CONTEXT).toMatch(
      /'tournamentsEnabled',v_club\.asset='diamonds' AND COALESCE\(\s+\(SELECT s\.tournaments_enabled FROM public\.ca_arena_settings s WHERE s\.club_id=v_club\.id\),false\)/
    );
  });

  it('the registration core answers each ordinary Diamond refusal with a reason and re-raises the rest', () => {
    expect(pinnedEdits(REGISTRATION)).toEqual({ pins: 1, reversals: 1 });
    expect(REGISTRATION).toContain("'b61a71ab40f7c1f5da7913f7cd4e753c'");
    for (const [message, reason] of [
      ['insufficient_settled_diamonds', 'insufficient_diamonds'],
      ['diamond_tournaments_not_open', 'diamond_tournaments_not_open'],
      ['diamond_debt_requires_settlement', 'diamond_debt_requires_settlement'],
      ['diamond_tournament_entry_already_held', 'already_registered'],
    ]) {
      expect(REGISTRATION).toContain(`SQLERRM LIKE '%${message}%'`);
      expect(REGISTRATION).toContain(`'reason', '${reason}'`);
    }
    const handler = sliceBetween(REGISTRATION, 'EXCEPTION WHEN OTHERS THEN', '$n$;');
    expect(handler).toMatch(/\n\s+RAISE;\s+END;/);
    expect(REGISTRATION).toContain(
      "'asset', CASE WHEN v_dia IS NOT NULL THEN 'diamonds' ELSE 'chips' END"
    );
    expect(REGISTRATION).toContain(
      "'diamonds_after', CASE WHEN v_dia IS NOT NULL THEN (SELECT p.diamonds FROM public.profiles p WHERE p.id = v_uid) END"
    );
    expect(REGISTRATION).toContain('ARRAY[v_old1, v_old2]');
  });

  it('the Diamond unregistration receipt carries the wallet after, and stays owner-only', () => {
    expect(pinnedEdits(UNREGISTER)).toEqual({ pins: 1, reversals: 1 });
    expect(UNREGISTER).toContain("'3db98d05ceb29eb7e843b573d3b1d65a'");
    expect(UNREGISTER).toContain(
      "'asset','diamonds','diamonds_after',(SELECT p.diamonds FROM public.profiles p WHERE p.id=p_user_id)"
    );
    expect(FINAL).toContain("has_function_privilege('authenticated', r.oid, 'EXECUTE')");
  });

  it('asserts at the end that the chip debit and the Diamond charge are both still there', () => {
    expect(FINAL).toContain("position('public.atomic_deduct_wallet_and_log(' in r.def)=0");
    expect(FINAL).toContain("position('public.fn_poker_diamond_tournament_charge(' in r.def)=0");
    expect(FINAL).toContain("'tournamentsEnabled'");
  });
});
