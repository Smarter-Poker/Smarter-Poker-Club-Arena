import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CANDIDATE IS NOTICED THE SECOND IT IS READY (2026-10-24).
 *
 * After launch, the release transaction waits for the candidate's exact local
 * health and then for the public proxy to serve the same instance, before the
 * final database proof. Both loops slept 5 s between reads, so a ready
 * candidate lost on average 2.5 s (up to 5 s) twice. Release e4f793b6 reached
 * the final database proof 7-10 s too late for its 17 s floor above the 135 s
 * rollback reserve and rolled back. The loops now read every second; their
 * total windows (180 s and 90 s) and every proof are unchanged.
 */
const transaction = readFileSync(
  join(process.cwd(), 'server/scripts/engine-release-transaction.sh'),
  'utf8'
);
const launch = transaction.indexOf('"$ENGINE_UP" 3<<<"$TOKEN"');
const proof = transaction.indexOf("die 'deadline expired before final database proof'", launch);
const window = transaction.slice(launch, proof);

const loop = (dieMessage: string) => {
  const end = window.indexOf(dieMessage);
  const start = window.lastIndexOf('for attempt in $(seq 1 ', end);
  const body = window.slice(start, window.indexOf('\ndone', end));
  const attempts = Number(/seq 1 (\d+)\)/.exec(body)![1]);
  const sleep = Number(/bounded_sleep (\d+)/.exec(body)![1]);
  const last = Number(/\[ "\$attempt" = (\d+) \]/.exec(body)![1]);
  return { attempts, sleep, last, body };
};

describe('the transaction notices a ready candidate within a second', () => {
  it('finds the launch, both health loops and the database proof in order', () => {
    expect(launch).toBeGreaterThan(0);
    expect(proof).toBeGreaterThan(launch);
  });

  it('polls local health every second over the unchanged 180 s window', () => {
    const local = loop("die 'candidate never served exact local release health'");
    expect(local.sleep).toBe(1);
    expect(local.attempts).toBe(local.last);
    expect(local.attempts * local.sleep).toBe(180);
    expect(local.body).toContain("health_instance 'http://127.0.0.1:8080/health'");
    expect(local.body).toContain('assert_break_proof_time');
  });

  it('polls the public proxy every second over the unchanged 90 s window', () => {
    const pub = loop("die 'public proxy never served the exact candidate release'");
    expect(pub.sleep).toBe(1);
    expect(pub.attempts).toBe(pub.last);
    expect(pub.attempts * pub.sleep).toBe(90);
    expect(pub.body).toContain('[ "$PUBLIC_INSTANCE" = "$CANDIDATE_INSTANCE" ] && break');
    expect(pub.body).toContain('assert_break_proof_time');
  });

  it('never sleeps 5 s between the launch and the final database proof', () => {
    expect(window).not.toMatch(/bounded_sleep [2-9]/);
  });

  it('keeps the rollback reserve and the database proof floor', () => {
    expect(transaction).toContain('BREAK_ROLLBACK_RESERVE_SECONDS=135');
    expect(transaction).toContain(
      '[ "$DB_TIMEOUT" -ge 17 ] || die \'insufficient maintenance-break budget for final database proof\''
    );
  });
});
