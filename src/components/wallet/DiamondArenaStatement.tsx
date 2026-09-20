/**
 * DIAMOND ARENA STATEMENT (phase 4).
 *
 * THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER. (Dan, 2026-09-13.)
 *
 * A real poker room hands a player a statement: what went in, what came out,
 * and that every line reconciles. This is that statement for the Diamond
 * Arena, read from `fn_diamond_arena_reconciliation` - sessions, buy-ins,
 * cash-outs, diamonds in play, the settled result, and any session or
 * movement that does not reconcile, named by reason.
 *
 * It reports; it never repairs. The live paths (buy-in, top-up, release) are
 * atomic and settlement-gated, so the expected reading is "every session
 * reconciles". A line here that does not is a fact for the player to see and
 * for operations to fix at the root - never a sweep (CLAUDE.md 10.12).
 *
 * Three outcomes, never a zero that means unknown: reading, failed
 * (Unavailable + Retry), known.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { masterBus } from '../../core/MasterBus';
import {
  DiamondService,
  type DiamondArenaStatement as Statement,
} from '../../services/DiamondService';
import { useIsMounted } from '../../hooks/useIsMounted';
import { unmatchedSentence } from './arenaStatementCopy';
/* The statement renders only on the wallet page and prints into its
   vocabulary (vault-panel, earn-stats, incoming-row); the stylesheet that
   defines those is the wallet's own. */
import '../../pages/PlayerWalletPage.css';

const fmt = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString();

export default function DiamondArenaStatement({ userId }: { userId: string | undefined }) {
  const isMounted = useIsMounted();
  const [statement, setStatement] = useState<Statement | null | undefined>(undefined);
  const seq = useRef(0);

  // A re-read keeps the last known statement on screen until the new one
  // arrives, and only the latest read is allowed to land (phase 5 deep dive:
  // overlapping reads must not let an older answer overwrite a newer one).
  const load = useCallback(async () => {
    if (!userId) return;
    const mine = ++seq.current;
    setStatement((prev) => (prev ? prev : undefined));
    const next = await DiamondService.getArenaStatement();
    if (isMounted.current && mine === seq.current) setStatement(next);
  }, [userId, isMounted]);

  useEffect(() => {
    void load();
  }, [load]);

  // A buy-in or a cash-out changes the statement; re-read while it is open.
  useEffect(() => {
    if (!userId) return;
    return masterBus.subscribeDebounced('BALANCE_UPDATED', () => void load(), 1500);
  }, [userId, load]);

  if (statement === undefined) {
    return <div className="vault-empty">Reading Your Diamond Arena Statement...</div>;
  }
  if (statement === null) {
    return (
      <div className="vault-empty" role="alert">
        Your Diamond Arena Statement Could Not Be Read.{' '}
        <button type="button" className="vault-link" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (statement.sessions === 0) {
    return (
      <div className="vault-empty">
        No Diamond Arena Sessions Yet. Every Buy-In And Cash-Out Will Be Listed Here.
      </div>
    );
  }
  const net = statement.netResultSettled;
  return (
    <div className="arena-statement">
      <dl className="earn-stats">
        <div className="earn-stat">
          <dt>Sessions</dt>
          <dd>
            {fmt(statement.sessions)}
            {statement.openSessions > 0 ? ` (${fmt(statement.openSessions)} Open)` : ''}
          </dd>
        </div>
        <div className="earn-stat">
          <dt>Buy-Ins</dt>
          <dd>{fmt(statement.buyIns)}</dd>
        </div>
        <div className="earn-stat">
          <dt>Cash-Outs</dt>
          <dd>{fmt(statement.cashOuts)}</dd>
        </div>
        <div className="earn-stat">
          <dt>In Play</dt>
          <dd className="diamond">{fmt(statement.inPlay)}</dd>
        </div>
        <div className="earn-stat">
          <dt>Settled Result</dt>
          <dd className={net > 0 ? 'positive' : undefined}>
            {net > 0 ? '+' : net < 0 ? '-' : ''}
            {fmt(Math.abs(net))}
          </dd>
        </div>
      </dl>
      {statement.balanced ? (
        <p className="vault-panel__sub" role="status">
          Every Session Reconciles: Each Buy-In And Cash-Out Matches Its Wallet Entry.
        </p>
      ) : (
        <div role="alert">
          <p className="vault-panel__sub">
            {fmt(statement.unmatched.length)} Line
            {statement.unmatched.length === 1 ? ' Does' : 's Do'} Not Reconcile. Nothing Has Been
            Taken From You; Operations Corrects The Record At The Source.
          </p>
          <ul className="incoming-list">
            {statement.unmatched.map((u, i) => (
              <li key={`${u.custodyId}-${u.requestId ?? i}`} className="incoming-row">
                <div className="incoming-row__body">
                  <span className="incoming-row__label">{unmatchedSentence(u.reason)}</span>
                  <span className="incoming-row__desc">Session {u.custodyId.slice(0, 8)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
