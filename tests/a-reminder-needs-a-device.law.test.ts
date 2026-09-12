/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A REMINDER NEEDS A DEVICE TO REACH (2026-09-12, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `prepare_tournament_reminders` wrote one push_outbox row per registrant per
 * tournament starting inside fifteen minutes, and never asked whether the
 * recipient owned a device. Measured on production over seven days:
 *
 *     15,900 tournament-reminder rows  (94.9% of ALL push_outbox volume)
 *        935 distinct recipients
 *          0 with an active push subscription
 *          0 that had ever held a push_subscriptions row when the row was written
 *          0 delivered - every one skipped with failure_reason='no_subscription'
 *
 * The dispatcher was right every time; there was nowhere to send them. Two
 * things followed. The 100% skip rate read as "push is broken" and buried the
 * real signal, and the candidate loop's `LIMIT 300` was being spent on 1,266
 * undeliverable rows, so a genuine registrant with a device and an unlucky UUID
 * could be sorted out of her own reminder.
 *
 * THE LAW. No tournament reminder is enqueued for a recipient with no active
 * push subscription, and the thing that decides is REACHABILITY - the presence
 * of a device - and never what kind of player the recipient is.
 *
 * WHY THAT SECOND HALF IS THE WHOLE POINT (CLAUDE.md 10.5). Every recipient in
 * the measurement above was a horse, so "filter out the horses" describes the
 * same 15,900 rows and is the obvious shortcut. It is also precisely the bug
 * that cost 39 tournaments their entire rake attribution on 2026-08-27. A human
 * with no subscription must be filtered by the SAME line as a horse with no
 * subscription, and a horse that enrols a device must get its reminder like
 * anybody else. These tests fail if anyone ever "simplifies" the predicate into
 * a species check.
 *
 * Registry: docs/laws.d/a-reminder-needs-a-device.md
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

const ENQUEUE = 'prepare_tournament_reminders';
const CLAIM_TRIGGER = 'trg_claim_tournament_reminder';

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Migrations apply in filename order, so the routine that RUNS is the one in
 * the last file that defines it. Reading the whole directory as one blob - the
 * cheap way - would let a predicate deleted today still be found in the file
 * that first introduced it, and the law would pass over its own corpse.
 */
function latestDefinition(fn: string): { file: string; sql: string } {
  const open = `CREATE OR REPLACE FUNCTION public.${fn}`;
  let found: { file: string; sql: string } | null = null;
  for (const file of migrationFiles()) {
    const text = readFileSync(resolve(MIGRATIONS, file), 'utf8');
    const start = text.lastIndexOf(open);
    if (start === -1) continue;
    const end = text.indexOf('$function$;', start);
    expect(end, `${file} opens ${fn} and never closes it`).toBeGreaterThan(start);
    found = { file, sql: text.slice(start, end) };
  }
  expect(found, `no migration defines ${fn}`).not.toBeNull();
  return found!;
}

/**
 * What the database executes, normalised. Comments are stripped - a promise in
 * a comment is not a predicate - and parentheses are spaced out so the
 * assertions below pin the PREDICATE rather than one author's whitespace.
 */
function code(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/([()])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

const enqueue = latestDefinition(ENQUEUE);
const trigger = latestDefinition(CLAIM_TRIGGER);

/**
 * THE CANDIDATE SELECT ALONE - the rows this function actually writes.
 *
 * Scoped deliberately. The first draft searched the whole function body, and a
 * mutation run proved that useless: delete the predicate from the loop, leave
 * the identical one in the `next_due_at` report below, and the assertion still
 * found a match and went green while the defect was fully restored. A window
 * that spans past the thing under test is testing its neighbour.
 */
function candidateSelect(): string {
  const body = code(enqueue.sql);
  const start = body.indexOf('FOR c IN');
  const end = body.indexOf('LOOP INSERT INTO public.push_outbox', start);
  expect(start, `${enqueue.file}: ${ENQUEUE} has no candidate loop`).toBeGreaterThan(-1);
  expect(end, `${enqueue.file}: the candidate loop never reaches its INSERT`).toBeGreaterThan(
    start
  );
  return body.slice(start, end);
}

describe('a reminder needs a device to reach', () => {
  it('the enqueue asks whether the recipient has a live device', () => {
    // The candidate loop, which is the thing that writes the rows.
    expect(
      candidateSelect(),
      `${enqueue.file}: ${ENQUEUE} selects candidates without asking whether they can be reached`
    ).toMatch(
      /AND EXISTS \( SELECT 1 FROM public\.push_subscriptions (\w+) WHERE \1\.user_id = tp\.user_id AND \1\.is_active \)/
    );
  });

  it('what it reports as due is what it will actually queue', () => {
    // `next_due_at` enumerates the same registrants. Left unfiltered it names a
    // due time for an audience the loop has correctly decided never to serve,
    // which is a scheduler being told there is work when there is none.
    const dueBlock = code(enqueue.sql).split('INTO v_next')[1] || '';
    expect(
      dueBlock,
      `${enqueue.file}: next_due_at counts recipients the loop will never queue`
    ).toMatch(
      /EXISTS \( SELECT 1 FROM public\.push_subscriptions (\w+) WHERE \1\.user_id = tp\.user_id AND \1\.is_active \)/
    );
  });

  it('the BEFORE INSERT trigger refuses an unreachable recipient at the table', () => {
    // A predicate that lives only in one function's WHERE clause is a
    // convention. The next caller walks around it without noticing.
    expect(
      code(trigger.sql),
      `${trigger.file}: ${CLAIM_TRIGGER} lets an undeliverable row into push_outbox`
    ).toMatch(
      /IF NOT EXISTS \( SELECT 1 FROM public\.push_subscriptions (\w+) WHERE \1\.user_id = NEW\.recipient_user_id AND \1\.is_active \) THEN RETURN NULL;/
    );
  });

  it('refusing an unreachable recipient claims no receipt', () => {
    // A receipt is permanent: claim one and the player who turns notifications
    // on four minutes before the event never gets the reminder they just asked
    // for. The gate must therefore come BEFORE the receipt write, not after.
    const body = code(trigger.sql);
    const gate = body.indexOf('IF NOT EXISTS ( SELECT 1 FROM public.push_subscriptions');
    const receipt = body.indexOf('INSERT INTO public.tournament_reminder_receipts');
    expect(gate, 'the reachability gate is missing from the trigger').toBeGreaterThan(-1);
    expect(receipt, 'the receipt claim is missing from the trigger').toBeGreaterThan(-1);
    expect(
      gate,
      'the trigger claims a receipt before it checks reachability, so a device enrolled inside the window is ignored for ever'
    ).toBeLessThan(receipt);
  });

  it.each([
    [ENQUEUE, enqueue],
    [CLAIM_TRIGGER, trigger],
  ])('%s gates on reachability, never on species', (_name, def) => {
    // CLAUDE.md 10.5. Every recipient of the 15,900 undeliverable rows was a
    // horse, so `AND NOT p.is_horse` produces the same row count today and is
    // the shortcut this law exists to refuse. It is wrong in both directions: it
    // would keep queueing for a HUMAN with no device, and it would refuse a
    // horse that has one.
    const body = code(def.sql);
    for (const forbidden of ['is_horse', 'is_bot', 'is_house']) {
      expect(
        body.includes(forbidden),
        `${def.file}: ${_name} decides who gets a reminder with ${forbidden}. ` +
          `The question is whether a device exists, not what kind of player owns it.`
      ).toBe(false);
    }
    // And the reachability test reads the subscription table, not the roster.
    expect(body).toContain('public.push_subscriptions');
  });

  it('the idempotency guard it already had is still the only one', () => {
    // The receipts table plus the BEFORE INSERT claim already give exactly one
    // row per (tournament, recipient, scheduled_start_at, stage) - 10,707
    // duplicate claims suppressed in twelve hours. Nothing here replaces it,
    // and nothing here is a second mechanism beside it.
    expect(
      candidateSelect(),
      `${enqueue.file}: the receipts guard was removed from the candidate loop`
    ).toContain('NOT EXISTS ( SELECT 1 FROM public.tournament_reminder_receipts');
    expect(code(trigger.sql)).toContain('ON CONFLICT DO NOTHING RETURNING true INTO v_claimed');
  });

  it('the partial index the predicate rides on is declared in this repo', () => {
    // It was live and in no migration, so a rebuild from this directory would
    // have produced the predicate without the index that makes it free.
    const all = code(
      migrationFiles()
        .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
        .join('\n')
    );
    expect(
      all,
      'no migration declares push_subscriptions_user_active_idx on (user_id) WHERE is_active'
    ).toMatch(
      /CREATE INDEX IF NOT EXISTS push_subscriptions_user_active_idx ON public\.push_subscriptions \( user_id \) WHERE is_active/
    );
  });
});
