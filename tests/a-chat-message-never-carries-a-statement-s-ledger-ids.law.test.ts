/**
 * ===========================================================================
 *  A CHAT MESSAGE NEVER CARRIES A STATEMENT'S LEDGER ID LIST
 * ===========================================================================
 *
 * 2026-10-05: the Deep Stack Society weekly statement CA-2026-00000608 reached
 * Messenger with 'lines.private_bank_ledger_ids' in its media_metadata - about
 * 197k ledger ids, 8.7 MB in one message. Turning that page into JSON took
 * 27-32 s against service_role's 8 s statement_timeout, so the thread returned
 * 503 on every open and never loaded.
 *
 * THE CAUSE. fn_deliver_accounting_invoice delivered the breakdown as 'lines'
 * minus 'source_ledger_ids', the statement's only id list when delivery was
 * written. 20260928164258 added a second list, 'private_bank_ledger_ids', to
 * fn_club_weekly_accounting_summary and nobody widened the exclusion.
 *
 * THE LAW. Every '*_ledger_ids' key a weekly statement emits is (1) excluded by
 * the newest delivery 'lines' and (2) stripped by the newest projection of both
 * private messenger readers. A new id list on the statement turns this red
 * until the delivery and the readers are widened with it in the same change.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }));

const statementIdLists = new Set<string>();
for (const { sql } of files) {
  if (!sql.includes('fn_club_weekly_accounting_summary')) continue;
  for (const match of sql.matchAll(/'([a-z_]+_ledger_ids)'\s*,/g)) statementIdLists.add(match[1]);
}

const newest = (pattern: RegExp) => [...files].reverse().find(({ sql }) => pattern.test(sql));

describe('a chat message never carries a statement ledger id list', () => {
  it('finds the statement id lists it guards', () => {
    expect([...statementIdLists]).toEqual(expect.arrayContaining(['source_ledger_ids', 'private_bank_ledger_ids']));
  });

  it('the delivered lines exclude every statement id list', () => {
    const writer = newest(/'lines',inv\.breakdown-ARRAY\[/);
    expect(writer, 'no migration delivers lines with an exclusion list').toBeDefined();
    const excluded = [...writer!.sql.matchAll(/'lines',inv\.breakdown-ARRAY\[([^\]]*)\]/g)].at(-1)![1];
    for (const key of statementIdLists) expect(excluded, `${writer!.name} delivers ${key}`).toContain(`'${key}'`);
  });

  it('both private readers strip every statement id list from what they project', () => {
    const reader = newest(/#- '\{lines,[a-z_]+_ledger_ids\}'/);
    expect(reader, 'no migration strips an id list from the reader projection').toBeDefined();
    for (const fn of ['fn_messenger_message_page', 'fn_messenger_search_messages']) expect(reader!.sql).toContain(fn);
    for (const key of statementIdLists) expect(reader!.sql, `${reader!.name} projects ${key}`).toContain(`#- '{lines,${key}}'`);
  });
});
