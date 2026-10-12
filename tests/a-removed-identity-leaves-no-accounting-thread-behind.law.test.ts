/**
 * ===========================================================================
 *  A REMOVED IDENTITY LEAVES NO ACCOUNTING THREAD BEHIND
 * ===========================================================================
 *
 * 2026-10-05: Deep Stack Society's Messages tab held six one-member threads
 * called "... Accounting", each a copy of an invoice delivered to the reserved
 * post-deploy certification identity. cleanup_reserved_certification_account
 * removed that identity's delivery rows and accounting_conversations mapping
 * and deliberately left the social conversation in place; the profile cascade
 * took the identity's participant row, and the sender was left alone in an
 * unmapped thread Messenger files under Messages.
 *
 * THE LAW. The newest migration that defines the cleanup's mapping delete
 * removes the unmapped social conversations in the same statement.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const newest = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .reverse()
  .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }))
  .find(({ sql }) => sql.includes('cleanup_reserved_certification_account') && sql.includes('DELETE FROM public.accounting_conversations'));

describe('a removed identity leaves no accounting thread behind', () => {
  it('the cleanup deletes the social conversations it unmaps, in the same statement', () => {
    expect(newest, 'no migration defines the cleanup mapping delete').toBeDefined();
    const sql = newest!.sql.replace(/'\s*\|\|\s*E'/g, '').replace(/\\n/g, '\n');
    expect(sql, newest!.name).toMatch(
      /WITH unmapped AS \(\s*DELETE FROM public\.accounting_conversations\s+WHERE recipient_id = p_user_id OR sender_id = p_user_id\s+RETURNING conversation_id\s*\)\s*DELETE FROM public\.social_conversations s\s+WHERE s\.id IN \(SELECT conversation_id FROM unmapped\);/
    );
  });
});
