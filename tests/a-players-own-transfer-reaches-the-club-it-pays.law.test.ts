/**
 * LAW - A PLAYER'S OWN TRANSFER REACHES THE CLUB IT PAYS
 *
 * Found 2026-10-06 proving the club-leave fixes against production: no member
 * holding chips could leave any club. Leaving moves the member's wallet to
 * the club treasury; fn_deliver_accounting_invoice addressed that transfer's
 * invoice through fn_accounting_party_users, which answers only to the engine
 * or to a member of the party asked about. The leaving player is the issuer
 * and never one of the club's officers, so the recipient side came back
 * empty and delivery raised accounting_invoice_recipient_missing, rolling the
 * whole leave back.
 *
 * Migration 20261006044028 gives delivery its own resolver of the parties of
 * record (same rule, no caller filter, no browser role may execute it) and
 * leaves fn_accounting_party_users, the browser-facing one, untouched.
 *
 * The unit suite has no database, so this pins the migration's shape and that
 * no later migration puts the caller-filtered lookup back into delivery.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const NAME = '20261006044028_a_players_own_transfer_reaches_the_club_it_pays.sql';
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

describe("a player's own transfer reaches the club it pays", () => {
  const sql = read(NAME);

  it('delivery resolves both parties through its own resolver', () => {
    expect(sql).toContain(
      'INTO issuer_users FROM public.fn_accounting_invoice_party_users(inv.from_entity_type,issuer_id);'
    );
    expect(sql).toContain(
      'INTO recipient_users FROM public.fn_accounting_invoice_party_users(inv.to_entity_type,recipient_id);'
    );
  });

  it('the resolver carries the party rule and no caller filter', () => {
    const start = sql.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_accounting_invoice_party_users('
    );
    const end = sql.indexOf('$function$;', start);
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, end);
    expect(body).toContain("m.role IN('owner','co_owner','admin')");
    expect(body).toContain('public.fn_union_overseer_of_record(p_id,a.user_id)');
    expect(body).not.toContain('auth.uid()');
    expect(body).not.toContain('fn_caller_is_engine');
  });

  it('no browser role may execute the resolver', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_accounting_invoice_party_users(text, uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.fn_accounting_invoice_party_users[^;]*\b(anon|authenticated|PUBLIC)\b/i
    );
    expect(sql).toContain('a browser role can execute the delivery resolver');
  });

  it('does not change what a browser may see', () => {
    expect(sql).not.toMatch(/FUNCTION\s+public\.fn_accounting_party_users\s*\(/i);
  });

  it('refuses a definition it was not written against, and is one transaction', () => {
    expect(sql).toContain("md5(v_def) <> '4c24964a287ef93afd2e56f866416b17'");
    expect(sql).toContain('invoice delivery still resolves a party through the caller filter');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('no later migration puts the caller-filtered lookup back into delivery', () => {
    for (const f of files.filter((name) => name > NAME)) {
      const body = read(f);
      if (
        !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.fn_deliver_accounting_invoice\b/i.test(body)
      ) {
        continue;
      }
      expect(body, `${f} redefines invoice delivery`).toContain(
        'fn_accounting_invoice_party_users('
      );
    }
  });
});
