/**
 * THE INBOX NEVER SHOWS A NAMELESS THREAD, AND READING CLEARS ITS ALERTS
 *
 * Dan, 2026-10-24: "REMOVE ANY AND ALL MESSAGES FROM 'UNKNOWN' AND NEW PLAYERS
 * SHOULD NEVER BE 'UNKNOWN' THEY SHOULD ALWAYS HAVE A NAME ATTACHED" and
 * "NOTIFICATIONS COUNTER SHOULD DISAPPEAR AFTER YOU CLICK AND READ MESSAGES".
 *
 * Measured that day: 435 one-to-one threads had no other participant. 433
 * were the agent welcome sent to post-deploy certification probes
 * (ca-customization-cert-postdeploy-%@example.invalid) that joined the owner's
 * club and were deleted a median 52 s later, leaving the sender with a thread
 * that rendered as "Unknown". All 4 unread new_message notifications belonged
 * to threads already read, because the read receipt never touched them.
 *
 * Pins, on the newest migration that defines each function:
 *   1. fn_get_user_conversations lists a one-to-one thread only while the
 *      other person exists, and always names them (Player #<number> last),
 *      without reading the protected full_name.
 *   2. fn_mark_messages_read_through clears that thread's new_message alerts.
 *   3. fn_deliver_club_messenger_welcome skips certification equipment, and
 *      does it through fn_ca_is_cert_account, which never classifies a horse
 *      (CLAUDE.md 10.5): no is_horse test of its own.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(DIR).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();

function latestBody(name: string): string {
  const header = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`, 'i');
  for (const file of [...files].reverse()) {
    const sql = readFileSync(join(DIR, file), 'utf8');
    const start = sql.search(header);
    if (start < 0) continue;
    const rest = sql.slice(start);
    const end = rest.search(/\$function\$\s*;/);
    return rest.slice(0, end > 0 ? end : rest.length);
  }
  throw new Error(`no migration defines public.${name}`);
}
const code = (body: string) => body.replace(/--[^\n]*/g, '');

describe('the inbox never shows a nameless thread', () => {
  it('lists a one-to-one thread only while the other person exists', () => {
    const body = code(latestBody('fn_get_user_conversations'));
    expect(body).toMatch(/AND\s*\(\s*COALESCE\(c\.is_group,\s*false\)\s+OR\s+ou\.id\s+IS\s+NOT\s+NULL\s*\)/i);
  });

  it('always names the other person, falling back to the player number', () => {
    const body = code(latestBody('fn_get_user_conversations'));
    expect(body).toContain("'Player #'");
    expect(body).toMatch(/ou\.player_number/);
    expect(body).not.toMatch(/full_name/);
  });
});

describe('reading a thread clears its message alerts', () => {
  it('marks the reader\'s new_message notifications for that thread read', () => {
    const body = code(latestBody('fn_mark_messages_read_through'));
    expect(body).toMatch(/UPDATE\s+notifications/i);
    expect(body).toContain("type='new_message'");
    expect(body).toMatch(/data->>'conversationId'\s*=\s*p_conversation_id::text/);
    // A message that arrives after the read point keeps its own alert.
    expect(body).toMatch(/created_at\s*<\s*COALESCE\(v_next_unread/);
  });
});

describe('the agent welcome never goes to certification equipment', () => {
  it('skips accounts the certification predicate claims, and only those', () => {
    const body = code(latestBody('fn_deliver_club_messenger_welcome'));
    expect(body).toMatch(/IF\s+public\.fn_ca_is_cert_account\(NEW\.user_id\)\s+THEN\s+RETURN\s+NEW;/i);
    // Horses are players: the trigger never decides by is_horse itself.
    expect(body).not.toMatch(/is_horse/i);
  });
});
