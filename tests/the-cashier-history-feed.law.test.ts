/**
 * THE CASHIER HISTORY FEED (Dan 2026-10-24, binding)
 *
 * "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE": club-wide totals,
 * server search, fast paging, a row's receipt, one player inside a downline,
 * and a waiting cash-out shown as waiting.
 *
 * Pins migration 20261025025659:
 *   - the book is decided once (fn_cashier_history_book) and only narrows; a
 *     person narrows any book to one of its members and nothing outside it;
 *   - paging is a (created_at, id) cursor, never an offset;
 *   - a search is an exact invoice number or part of a member's arena name;
 *   - every cash-out leg carries its request status and invoice number;
 *   - club totals come from closed UTC days counted once (the ledger is
 *     append-only) plus the open edges read live; no schedule, no ledger
 *     trigger, and the answer says when it is not complete;
 *   - the helper and the cache are unreachable from a browser.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    __dirname,
    '..',
    'supabase/migrations/20261025025659_cashier_history_feed_search_cursor_person_and_club_totals.sql'
  ),
  'utf8'
);
const feed = sql.slice(sql.indexOf('FUNCTION public.fn_cashier_history_feed('));
const summary = sql.slice(sql.indexOf('FUNCTION public.fn_cashier_history_summary('));

describe('the cashier history feed', () => {
  it('decides the book once, and a person can only narrow it', () => {
    expect(sql).toContain(
      "WHEN v_scope = 'club' AND v_role IN ('owner', 'co_owner', 'admin') THEN 'club'"
    );
    expect(sql).toContain(
      "WHEN v_scope = 'downline' AND v_role IN ('super_agent', 'agent', 'sub_agent') THEN 'downline'"
    );
    expect(sql).toContain("OR (book = 'downline' AND p_person = ANY (people)) THEN");
    expect(sql).toMatch(/ELSE\s+book := NULL;\s+RETURN;/);
    expect(feed).toContain(
      'FROM public.fn_cashier_history_book(p_club_id, v_viewer, p_scope, p_person) b;'
    );
    expect(summary).toContain(
      'FROM public.fn_cashier_history_book(p_club_id, v_viewer, p_scope, p_person) b;'
    );
  });

  it('pages by cursor, never by offset', () => {
    expect(feed).toContain("' AND (ct.created_at, ct.id) < ($6, $7)'");
    expect(feed).not.toMatch(/OFFSET/);
    expect(feed).toContain("RAISE EXCEPTION 'transaction_history_cursor_invalid'");
  });

  it('searches an exact invoice number or part of a member arena name', () => {
    expect(feed).toContain("IF v_search ~* '^CA-[0-9]{4}-[0-9]+$' THEN");
    expect(feed).toContain('WHERE i.invoice_number = upper(v_search) AND i.club_id = p_club_id');
    expect(feed).toContain(
      "ILIKE '%' || replace(replace(replace(v_search, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'"
    );
  });

  it('returns the request status and invoice number with every cash-out leg', () => {
    expect(feed).toContain(
      'request_status text, request_created_at timestamp with time zone, invoice_number text'
    );
    expect(feed).toContain('LEFT JOIN public.cashout_requests cr');
    expect(feed).toContain('LEFT JOIN public.settlement_invoices si ON si.id = ae.invoice_id');
  });

  it('keeps the presentation rules of the trade ledger', () => {
    expect(feed).toContain(
      "CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END"
    );
    expect(feed).toContain("ct.notes ~* 'horse'");
  });

  it('counts club totals from closed days once, reads the open edges live, and says when it is not complete', () => {
    expect(summary).toContain("IF clock_timestamp() - v_started > interval '2.5 seconds' THEN");
    expect(summary).toContain('ON CONFLICT (club_id, day, transaction_type) DO NOTHING;');
    expect(summary).toContain("'complete', v_complete");
    expect(sql).not.toMatch(/cron\.schedule|CREATE TRIGGER/);
  });

  it('reads one wallet by the Statement rule and a downline as one group', () => {
    expect(summary).toContain(
      "v_group := CASE WHEN v_book = 'downline' THEN v_people ELSE ARRAY[v_subject] END;"
    );
    expect(summary).toContain(
      "WHEN to_user_id = ANY ($2) AND NOT coalesce(from_user_id = ANY ($2), false) THEN 'in'"
    );
  });

  it('keeps the helper and the cache away from the browser', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cashier_history_book(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.cashier_club_day_totals FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(sql).toContain('ALTER TABLE public.cashier_club_day_totals ENABLE ROW LEVEL SECURITY;');
    expect(sql).not.toMatch(/REFERENCES/);
  });
});
