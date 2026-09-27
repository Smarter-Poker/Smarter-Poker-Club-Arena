/**
 * LAW: A MIRRORED PUSH NEEDS A DEVICE, AND NEVER ASKS ABOUT SPECIES.
 *
 * fn_mirror_notification_to_push_outbox turns every notifications row into a
 * push_outbox row. Measured on production 2026-09-27 over seven days, every
 * skipped no_subscription row it produced (71 accounting receipts to 37
 * recipients, 93 bonus rows to 83) was addressed to somebody with no device,
 * and the "97% accounting push failure" was those rows.
 *
 * The fix is the one tests/a-reminder-needs-a-device.law.test.ts already
 * pins for tournament reminders: ask whether the recipient has an ACTIVE
 * push_subscriptions row. Never ask is_horse (CLAUDE.md 10.5): a human with no
 * device is treated exactly like a horse with no device, and a horse that
 * enrols one is pushed like anybody else.
 *
 * The accounting branch must still write its durable receipt (the
 * 20260914141405 invariant), settled as skipped/no_subscription, and the owner
 * gate from 20260927143752 must still run ahead of it. Behaviour is proved in
 * scripts/dev/test-accounting-push-bridge.sh against a native Postgres; this
 * test keeps the shape from being "simplified" in a later migration.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');
const FN = 'fn_mirror_notification_to_push_outbox';

function latestDefinition(fn: string): { file: string; sql: string } {
  const open = `CREATE OR REPLACE FUNCTION public.${fn}`;
  let found: { file: string; sql: string } | null = null;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const text = readFileSync(resolve(MIGRATIONS, file), 'utf8');
    const start = text.lastIndexOf(open);
    if (start === -1) continue;
    // Older bodies use other dollar tags; close on whichever this one opened.
    const tag = /\bAS\s+(\$\w*\$)/.exec(text.slice(start))?.[1] ?? '$function$';
    const end = text.indexOf(`${tag};`, text.indexOf(tag, start) + tag.length);
    expect(end, `${file} opens ${fn} and never closes it`).toBeGreaterThan(start);
    found = { file, sql: text.slice(start, end) };
  }
  expect(found, `no migration defines ${fn}`).not.toBeNull();
  return found!;
}

/** Comments stripped, whitespace collapsed, parentheses spaced. */
function code(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/([()])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

const mirror = latestDefinition(FN);
const body = code(mirror.sql);
const DEVICE =
  /NOT EXISTS \( SELECT 1 FROM public\.push_subscriptions (\w+) WHERE \1\.user_id\s*=\s*notice\.user_id AND \1\.is_active \)/;

describe('a mirrored push needs a device', () => {
  it('the accounting branch settles an unreachable receipt instead of dropping it', () => {
    const branch = body.slice(0, body.indexOf('SELECT * INTO existing FROM public.push_outbox'));
    expect(branch, `${mirror.file}: accounting receipts ignore reachability`).toMatch(
      new RegExp(`ELSIF ${DEVICE.source} THEN state:='skipped';reason:='no_subscription';`)
    );
    // The receipt INSERT itself is still unconditional (20260914141405).
    expect(body).toContain(
      'INSERT INTO public.push_outbox ( recipient_user_id,title,body,url,event,tag,status,failure_reason,related_entity_id,accounting_notification_id )'
    );
  });

  it('the owner gate still decides before reachability does', () => {
    const owner = body.indexOf("reason:='owner_accounting_routed_to_production_alerts'");
    const device = body.indexOf("reason:='no_subscription'");
    expect(owner, `${mirror.file}: the owner gate is gone`).toBeGreaterThan(-1);
    expect(device).toBeGreaterThan(owner);
  });

  it('the ordinary branch writes nothing for a recipient with no device', () => {
    const ordinary = body.slice(
      body.indexOf("IF notice.type='accounting_invoice_detail' THEN RETURN NEW;")
    );
    expect(
      ordinary,
      `${mirror.file}: ordinary pushes are queued for unreachable recipients`
    ).toMatch(new RegExp(`IF ${DEVICE.source} THEN RETURN NEW; END IF;`));
    expect(ordinary.indexOf('RETURN NEW; END IF;')).toBeLessThan(
      ordinary.indexOf('INSERT INTO public.push_outbox')
    );
  });

  it('never decides by species', () => {
    expect(mirror.sql, `${mirror.file}: ${FN} reads is_horse (CLAUDE.md 10.5)`).not.toMatch(
      /is_horse/i
    );
  });
});
