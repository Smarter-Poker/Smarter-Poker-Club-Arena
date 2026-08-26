/**
 * NO CLIENT MAY SUBSCRIBE TO A WHOLE TABLE.
 *
 * In April 2026 unfiltered `postgres_changes` listeners on `tables`,
 * `tournaments`, `clubs` and `unions` were removed after they produced roughly
 * 80% of 86 million realtime messages in a billing cycle. The rule that came
 * out of that: a client subscribes to ITS OWN rows, never to a table.
 *
 * `GlobalWaitlistListener` survived that cleanup and broke the rule anyway. It
 * is mounted in App.tsx for EVERY authenticated user and listened to
 * `table_seats` DELETE with no filter at all - so every seat vacated anywhere on
 * the platform (the horse fleet manager cycles seats continuously) was delivered
 * to every connected client, and each delivery then ran a `table_waitlist`
 * query. N users x M vacancies per minute, in both realtime messages AND
 * database queries, forever.
 *
 * It is now scoped to the tables the user is actually queuing for, and
 * subscribes to nothing at all when they are queuing for none - which is most
 * sessions.
 *
 * This spec asserts on the source because the failure mode is "somebody adds a
 * listener without a filter", which is a property of the code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const SRC = resolve(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Strip comments so prose describing a removed pattern cannot fail the test. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Tables whose row churn is driven by gameplay rather than by one user. An
 * unfiltered listener on any of these is a platform-wide firehose.
 */
const FIREHOSE_TABLES = [
  'table_seats',
  'hand_history',
  'tables',
  'tournaments',
  // Chip counts are rewritten on essentially every hand of every running
  // tournament, so an unfiltered listener here is one of the loudest feeds
  // in the database.
  'tournament_players',
  'clubs',
  'unions',
  'wallets',
  'chip_transactions',
  'rake_records',
];

describe('no client subscribes to an unfiltered high-churn table', () => {
  const files = walk(SRC);

  for (const table of FIREHOSE_TABLES) {
    it(`every postgres_changes listener on "${table}" carries a filter`, () => {
      const offenders: string[] = [];

      for (const file of files) {
        const code = codeOnly(readFileSync(file, 'utf8'));
        // Find each config object that names this table, then check the same
        // object literal for a `filter:` key. The config is always a short
        // inline object, so a bounded window around the match is reliable.
        const re = new RegExp(`table:\\s*['"]${table}['"]`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
          const start = Math.max(0, m.index - 240);
          const end = Math.min(code.length, m.index + 240);
          const window = code.slice(start, end);
          // A filter counts whether it is a literal template string or the
          // codebase's common conditional form:
          //   filter: user?.id ? `user_id=eq.${user.id}` : null
          // Requiring the value to START with a quote produced three false
          // positives (ClubDashboard, CashierPage, RakebackPage), all of which
          // are correctly scoped. What is NOT acceptable is a bare
          // `filter: null`, which makes useMasterBusChannel skip the
          // subscription entirely while reading as live coverage.
          const hasFilterKey = /filter:/.test(window);
          const isDeadNullFilter = /filter:\s*null\s*[,}]/.test(window);
          if (!hasFilterKey || isDeadNullFilter) {
            offenders.push(`${file.replace(SRC, 'src')} (near "${table}")`);
          }
        }
      }

      expect(offenders, `unfiltered listener(s) on ${table}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});

describe('GlobalWaitlistListener is scoped to the tables the user queues for', () => {
  const LISTENER = readFileSync(
    resolve(SRC, 'components/common/GlobalWaitlistListener.tsx'),
    'utf8'
  );

  it('filters table_seats by the watched table ids', () => {
    expect(LISTENER).toMatch(/filter:\s*`table_id=in\.\(\$\{watched\.join\(','\)\}\)`/);
  });

  it('subscribes to nothing when the user is on no waitlist', () => {
    // The common case by far. Opening a channel for a player who is queuing for
    // nothing is pure cost.
    expect(LISTENER).toMatch(/if \(watched\.length === 0\)/);
  });

  it('keeps the watched set current, so joining a queue still works', () => {
    // Without this the filter would freeze at whatever was true on page load and
    // the auto-seat would silently stop working - worse than the cost it fixes.
    expect(LISTENER).toMatch(/refreshWatchedTables/);
    expect(LISTENER).toMatch(/table:\s*'table_waitlist'/);
    expect(LISTENER).toMatch(/filter:\s*`user_id=eq\.\$\{user\.id\}`/);
  });
});
