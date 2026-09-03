/**
 * COMMISSION ACCRUES FOR EVERY AGENT IN THE CHAIN, PER HAND.
 *
 * 2026-09-03, Chip Accounting Standard Phase 2 lane 2.2 (audit F2, High).
 *
 * credit_agent_commission_from_rake is called once per contributing player
 * of a cash hand, every call carrying the same source_id (the hand) and
 * source_type ('rake_settlement'). Its early-return guard asked "does ANY
 * row exist for this source" and never mentioned the agent, so the first
 * player's chain was booked and every later agent at the hand returned
 * before it was even looked up. Measured 93,536 direct rows over 93,536
 * distinct sources in 24h (one agent per hand, always); on hand 134a1847
 * (rake 8.00, two contributors of 4.00) the second contributor's agent
 * (2.00 at 50%) and super agent (1.40 at 70% override) were never booked.
 *
 * The rules this pins:
 *
 *   - the guard is keyed on the agent being booked, and it runs AFTER the
 *     agent has been resolved (a guard on a variable that is still NULL is
 *     no guard at all);
 *   - the source-only guard is gone;
 *   - both inserts still dedupe on (user_id, source_id, source_type) with DO
 *     NOTHING - that key is the idempotency contract with the settler and
 *     the retry path;
 *   - the accumulator bump stays gated on ROW_COUNT, so a replay bumps
 *     nothing;
 *   - the migration backfills nothing and moves no chips: it is one CREATE
 *     OR REPLACE, one self-check, no UPDATE or INSERT outside the function;
 *   - the function stays a plain (non SECURITY DEFINER) function called
 *     through the SECURITY DEFINER batch, exactly as before;
 *   - the self-check asserts the unique index the key relies on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const FILE = readdirSync(DIR).find((f) =>
  f.includes('commission_accrues_for_every_agent_in_the_chain')
);
const SQL = FILE ? readFileSync(resolve(DIR, FILE), 'utf8') : '';

/** The function body, bounded by its own dollar-quoted block. */
function body(): string {
  const open = SQL.indexOf('CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake');
  expect(open, 'credit_agent_commission_from_rake has moved or gone').toBeGreaterThan(-1);
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  expect(end, 'the function body is not dollar-quoted as expected').toBeGreaterThan(start);
  return SQL.slice(start, end);
}

/** Everything after the function body: the self-check and the COMMIT. */
function tail(): string {
  const open = SQL.indexOf('CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake');
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  return SQL.slice(end + '$function$'.length);
}

describe('commission accrues for every agent in the chain, per hand', () => {
  it('ships as a migration at all', () => {
    expect(FILE, 'the lane 2.2 migration is missing').toBeTruthy();
    expect(FILE).toMatch(/^20260903163422_/);
  });

  it('keys the idempotency guard on the agent being booked', () => {
    expect(body()).toMatch(
      /WHERE source_id = p_source_id AND source_type = p_source_type\s+AND user_id = v_agent_user_id/
    );
  });

  it('has no source-only guard left', () => {
    expect(body()).not.toMatch(
      /WHERE source_id = p_source_id AND source_type = p_source_type\s+LIMIT 1/
    );
  });

  it('resolves the agent BEFORE the guard reads v_agent_user_id', () => {
    const b = body();
    const resolved = b.indexOf('IF v_agent_id IS NULL THEN RETURN; END IF;');
    const guard = b.indexOf('AND user_id = v_agent_user_id');
    expect(resolved).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(resolved);
  });

  it('still dedupes both inserts on (user_id, source_id, source_type) DO NOTHING', () => {
    const b = body();
    const clauses = b.match(
      /ON CONFLICT \(user_id, source_id, source_type\) WHERE source_id IS NOT NULL\s+DO NOTHING/g
    );
    expect(
      clauses,
      'expected the direct and the super-agent insert to both carry the key'
    ).toHaveLength(2);
  });

  it('still gates the rake accumulator on the row actually inserted', () => {
    const b = body();
    expect(b).toContain('GET DIAGNOSTICS v_inserted_direct = ROW_COUNT;');
    expect(b).toMatch(/IF v_inserted_direct > 0 THEN\s+UPDATE agents SET/);
  });

  it('keeps the union law: the agent follows the player club', () => {
    expect(body()).toContain(
      'v_book_club := public.fn_resolve_player_club_for_agent(p_agent_user_id, p_club_id, NULL);'
    );
  });

  it('stays a plain function (the SECURITY DEFINER batch is the door, as before)', () => {
    const head = SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake'),
      SQL.indexOf('AS $function$')
    );
    expect(head).not.toMatch(/SECURITY DEFINER/i);
    expect(head).toContain("SET search_path TO 'public'");
  });

  it('backfills nothing and moves no chips', () => {
    // Outside the function body there is only the header, the CREATE, the
    // self-check and the transaction wrapper. No DML on any table.
    const outside = SQL.replace(body(), '');
    expect(outside).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(outside).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(outside).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(outside).not.toMatch(/chip_balance|chip_treasury|agent_wallet_balance/);
    // No index is built here (the self-check only quotes the existing one).
    expect(SQL).not.toMatch(/^\s*CREATE\s+(UNIQUE\s+)?INDEX/im);
  });

  it('self-checks the live body and the unique index it relies on', () => {
    const t = tail();
    expect(t).toContain("IF v_src NOT LIKE '%AND user_id = v_agent_user_id%' THEN");
    expect(t).toContain('the source-only guard is still in the live body');
    expect(t).toContain('the guard runs before the agent is known');
    expect(t).toContain(
      'CREATE UNIQUE INDEX uq_agent_commissions_source ON public.agent_commissions USING btree (user_id, source_id, source_type) WHERE (source_id IS NOT NULL)'
    );
    expect(t).toContain('must not be SECURITY DEFINER');
  });

  it('has no is_horse branch - horses are players and their agents are agents', () => {
    expect(SQL).not.toContain('is_horse');
  });

  it('uses no em dash', () => {
    expect(SQL).not.toContain('\u2014');
  });
});
