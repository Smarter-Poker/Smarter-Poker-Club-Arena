/**
 * ===========================================================================
 *  LAW - A TREASURY-FUNDED SEAT READS AS A CLUB BANK SEND
 * ===========================================================================
 *
 * Dan, binding: "NOTHING SHOULD EVER REVEAL A HORSES IDENTITY" and "HORSES ARE
 * NEVER EVER EXCLUDED BY DESIGN" (cashier launch, lead decision 2,
 * 2026-10-09). When the club treasury pays a horse's seat, the receipt is
 * chip_transactions.horse_treasury_funding and its journal leg is
 * chip_ledger.horse_funding. The Trade record (fn_club_trade_ledger), the Club
 * Bank ledger (fn_club_bank_ledger) and the treasury statement
 * (fn_ca_chip_statement_page, fn_ca_chip_statement) handed those to the
 * browser as they were: the kind, a note that says horse, a filter chip, and a
 * description ending in the horse's user id. Migration 20261012040542 makes
 * every Club Bank send read one way, a person's or a funded seat: kind
 * club_bank_send, from the Club Bank (the operator is named only to the
 * operator and to the member paid), the recipient by arena name, only a
 * typed reason as its note, only the destination as its metadata; the funded
 * seat's leg reads table_funding with no description. Every row is kept.
 * Qualified by scripts/ci/test-horse-reads-db-postgres.py on production's
 * live reads.
 *
 * Registry: docs/laws.d/a-treasury-funded-seat-reads-as-a-club-bank-send.md
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';

const FILE = '20261012040542_a_treasury_funded_seat_reads_as_a_club_bank_send.sql';
const POT = "('club_bank_send', 'horse_treasury_funding')";
/** Lead decision 2: a Club Bank send names its operator only to the operator
 * and to the member paid; a funded seat names no sender to anyone. */
const unnamed = (t: string, viewer: string): string =>
  `${t}.transaction_type = 'horse_treasury_funding' OR (${t}.transaction_type = 'club_bank_send' AND ${viewer} IS DISTINCT FROM ${t}.from_user_id AND ${viewer} IS DISTINCT FROM ${t}.to_user_id)`;
const squash = (s: string): string => s.replace(/\s+/g, ' ');

/** The newest definition of a function in the corpus: the one production runs. */
function newest(name: string): { file: string; body: string } {
  const defines = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i');
  const file = migrationNames()
    .filter((n) => defines.test(migrationText(n)))
    .at(-1)!;
  const text = migrationText(file);
  const start = text.search(defines);
  const tag = /\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(text.slice(start))!;
  const bodyStart = start + tag.index + tag[0].length;
  return { file, body: squash(text.slice(start, text.indexOf(tag[1], bodyStart))) };
}

describe('a treasury-funded seat reads as a Club Bank send', () => {
  const trade = newest('fn_club_trade_ledger');
  const bank = newest('fn_club_bank_ledger');
  const page = newest('fn_ca_chip_statement_page');
  const statement = newest('fn_ca_chip_statement');

  it('is defined last by the migration that fixed it, or by one that keeps the fix', () => {
    for (const read of [trade, bank, page, statement]) expect(read.file >= FILE).toBe(true);
  });

  it('the Trade record prints every Club Bank send one way, in every role branch', () => {
    const kinds = trade.body.split(
      "CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END"
    );
    expect(kinds).toHaveLength(4);
    for (const needle of [
      `CASE WHEN ${unnamed('ct', 'v_viewer')} THEN NULL ELSE ct.from_user_id END`,
      "CASE WHEN ct.transaction_type = 'horse_treasury_funding' OR ct.notes ~* 'horse' OR (ct.transaction_type = 'club_bank_send' AND ct.notes = 'Club Bank Send') THEN NULL ELSE ct.notes END",
      `CASE WHEN ct.transaction_type IN ${POT} THEN jsonb_build_object('destination', coalesce(ct.metadata ->> 'destination', 'player_wallet')) ELSE ct.metadata END`,
      `CASE WHEN pf.id IS NOT NULL AND NOT (${unnamed('ct', 'v_viewer')}) THEN public.fn_arena_name(`,
    ]) {
      expect(trade.body.split(needle), needle).toHaveLength(4);
    }
    expect(trade.body).not.toMatch(/SELECT ct\.id, ct\.created_at, ct\.transaction_type,/);
  });

  it('the Club Bank ledger lists, filters and counts a funded seat as a Club Bank send', () => {
    const kind =
      "CASE WHEN t.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE t.transaction_type END";
    expect(bank.body.split(`(p_types is null or (${kind}) = any (p_types))`)).toHaveLength(2);
    expect(bank.body).toContain('with per_type as (');
    expect(bank.body).toContain('where p_types is null or transaction_type = any (p_types)');
    expect(bank.body).toContain('coalesce(sum(entries) filter (');
    expect(bank.body).toContain('group by 1');
    expect(bank.body).toContain(
      "coalesce(jsonb_agg(transaction_type order by transaction_type), '[]'::jsonb)"
    );
    expect(bank.body).toContain(`'transaction_type', ${kind},`);
    expect(bank.body).toContain(
      `'from_user_id', CASE WHEN ${unnamed('t', 'auth.uid()')} THEN NULL ELSE t.from_user_id END,`
    );
    expect(bank.body).toContain(
      `'from_name', CASE WHEN ${unnamed('t', 'auth.uid()')} THEN NULL ELSE coalesce(`
    );
    expect(bank.body).toContain(
      `'metadata', CASE WHEN t.transaction_type IN ${POT} THEN jsonb_build_object('destination', coalesce(t.metadata ->> 'destination', 'player_wallet')) ELSE coalesce(t.metadata, '{}'::jsonb) END,`
    );
    expect(bank.body).not.toContain('select distinct transaction_type from chip_transactions');
  });

  it("the bank's figures still count exactly what they counted", () => {
    expect(bank.body).toContain(
      "where t.transaction_type in ('mint', 'club_bank_reversal', 'treasury_credit', 'club_bank_claim')"
    );
    expect(bank.body).toContain("where t.transaction_type in ('club_bank_send', 'treasury_debit')");
  });

  it('the treasury statement prints the funded seat leg as table funding, with no description', () => {
    for (const read of [page, statement]) {
      expect(read.body).toContain(
        "'category', CASE WHEN p.category = 'horse_funding' THEN 'table_funding' ELSE p.category END,"
      );
      expect(read.body).toContain(
        "'description', CASE WHEN p.category = 'horse_funding' OR p.description ~* 'horse' THEN NULL ELSE p.description END,"
      );
      expect(read.body).not.toContain("'category', p.category, 'description', p.description,");
    }
  });
});
