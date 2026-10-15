// The Estate Digest is a report, not an alert (2026-10-15). Addressed to the
// owner account it became a FIRING warning on the alert board every day,
// because his operational notices are routed to the Production Alerts store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { digestRecipients, OWNER_OPERATIONAL_ID } from '../../.github/scripts/estate-digest-recipients.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('the owner account is never an in-app recipient of the digest', () => {
  const others = ['0b0b0b0b-0000-4000-8000-000000000001', '0b0b0b0b-0000-4000-8000-000000000002'];
  assert.deepEqual(digestRecipients([OWNER_OPERATIONAL_ID, ...others, OWNER_OPERATIONAL_ID]), others);
  assert.deepEqual(digestRecipients([OWNER_OPERATIONAL_ID.toUpperCase()]), []);
});

test('every other platform recipient still receives it, once each', () => {
  const a = '0b0b0b0b-0000-4000-8000-00000000000a';
  assert.deepEqual(digestRecipients([a, a, null, '', undefined]), [a]);
  assert.deepEqual(digestRecipients(undefined), []);
});

test('the owner id is the one the database routes to the alert store', () => {
  const routing = readFileSync(
    `${root}supabase/migrations/20260916111614_owner_operational_notification_destination.sql`, 'utf8');
  assert.match(routing, new RegExp(`p_user='${OWNER_OPERATIONAL_ID}'::uuid`));
  assert.match(routing, /'estate_digest'/);
});

test('the digest delivers in-app only through digestRecipients', () => {
  const script = readFileSync(`${root}.github/scripts/estate-digest.mjs`, 'utf8');
  assert.match(script, /import \{ digestRecipients \} from '\.\/estate-digest-recipients\.mjs';/);
  assert.match(script, /for \(const r of digestRecipients\(recips\.map\(\(x\) => x\.user_id\)\)\)/);
  assert.equal((script.match(/fn_raise_notification/g) || []).length, 1);
});
