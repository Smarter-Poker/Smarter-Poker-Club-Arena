/**
 * WHERE YOUR DIAMONDS GO (phase 5).
 *
 * THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER. (Dan, 2026-09-13.)
 *
 * The wallet prints one Spent figure and one Earned figure. This panel is the
 * split behind them: every diamond spent, by what it bought (the Diamond
 * Arena, gifts, the store, VIP, club chips, games), and every diamond earned,
 * by where it came from (daily rewards, gifts, arena cash-outs, purchases,
 * winnings, social, refunds). Read from `fn_diamond_flow_by_kind`, which sums
 * the WHOLE ledger in SQL and buckets each row through
 * `fn_diamond_kind_bucket` - the one place a ledger kind is named, so this
 * panel and the World Hub wallet can never bucket the same row differently.
 *
 * Lifetime or the last 30 days, at the player's choice. Every figure on this
 * panel is diamonds; the panel has no chip vocabulary at all.
 *
 * Three outcomes, never a zero that means unknown: reading, failed
 * (Unavailable + Retry), known.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { masterBus } from '../../core/MasterBus';
import {
  DiamondService,
  type DiamondFlow,
  type DiamondFlowLine,
} from '../../services/DiamondService';
import { useIsMounted } from '../../hooks/useIsMounted';
import { amountIn, countIn, linesFor, shareOf, type DiamondFlowSpan } from './diamondFlowMath';
/* The panel renders only on the wallet page and prints into its vocabulary
   (vault-panel, vault-btn, vault-empty); the stylesheet that defines those is
   the wallet's own. */
import '../../pages/PlayerWalletPage.css';

const fmt = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString();

function FlowSide({
  title,
  lines,
  total,
  span,
  nothing,
  tone,
}: {
  title: string;
  lines: DiamondFlowLine[];
  total: number;
  span: DiamondFlowSpan;
  nothing: string;
  tone: 'spent' | 'earned';
}) {
  const shown = linesFor(lines, span);
  return (
    <section className="flow-side" aria-label={title}>
      <header className="flow-side__head">
        <span className="flow-side__title">{title}</span>
        <span className={`flow-side__total${tone === 'earned' ? ' positive' : ''}`}>
          {fmt(total)} Diamonds
        </span>
      </header>
      {shown.length === 0 ? (
        <p className="vault-empty">{nothing}</p>
      ) : (
        <ul className="flow-list">
          {shown.map((line) => {
            const amount = amountIn(line, span);
            const count = countIn(line, span);
            const share = shareOf(line, total, span);
            return (
              <li key={line.bucket} className="flow-row" data-bucket={line.bucket}>
                <div className="flow-row__head">
                  <span className="flow-row__label">{line.label}</span>
                  <span className="flow-row__amount">{fmt(amount)}</span>
                </div>
                <div
                  className="flow-bar"
                  role="img"
                  aria-label={`${line.label}: ${fmt(amount)} Diamonds, ${Math.round(share)} Percent Of ${title}`}
                >
                  <div className={`flow-bar__fill ${tone}`} style={{ width: `${share}%` }} />
                </div>
                <span className="flow-row__count">
                  {fmt(count)} {count === 1 ? 'Entry' : 'Entries'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function DiamondFlowPanel({ userId }: { userId: string | undefined }) {
  const isMounted = useIsMounted();
  const [flow, setFlow] = useState<DiamondFlow | null | undefined>(undefined);
  const [span, setSpan] = useState<DiamondFlowSpan>('lifetime');
  const seq = useRef(0);

  // A re-read keeps the last known figures on screen until the new ones
  // arrive (no flash to "Reading" on every balance change), and only the
  // latest read is allowed to land: two overlapping reads resolve in any
  // order, and the older one must not overwrite the newer.
  const load = useCallback(async () => {
    if (!userId) return;
    const mine = ++seq.current;
    setFlow((prev) => (prev ? prev : undefined));
    const next = await DiamondService.getDiamondFlow();
    if (isMounted.current && mine === seq.current) setFlow(next);
  }, [userId, isMounted]);

  useEffect(() => {
    void load();
  }, [load]);

  // A claim, a gift, a buy-in or a purchase moves diamonds between buckets;
  // re-read while the panel is open.
  useEffect(() => {
    if (!userId) return;
    return masterBus.subscribeDebounced('BALANCE_UPDATED', () => void load(), 1500);
  }, [userId, load]);

  if (flow === undefined) {
    return <div className="vault-empty">Reading Where Your Diamonds Go...</div>;
  }
  if (flow === null) {
    return (
      <div className="vault-empty" role="alert">
        Where Your Diamonds Go Could Not Be Read.{' '}
        <button type="button" className="vault-link" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (flow.spent.length === 0 && flow.earned.length === 0) {
    return (
      <div className="vault-empty">
        No Diamond Movements Yet. Every Diamond You Earn Or Spend Will Be Counted Here.
      </div>
    );
  }
  const spentTotal = span === 'lifetime' ? flow.spentTotal : flow.spentLast30;
  const earnedTotal = span === 'lifetime' ? flow.earnedTotal : flow.earnedLast30;
  return (
    <div className="flow-panel">
      <div className="flow-toggle" role="group" aria-label="Time Window">
        <button
          type="button"
          className={`vault-btn small${span === 'lifetime' ? ' primary' : ' ghost'}`}
          aria-pressed={span === 'lifetime'}
          onClick={() => setSpan('lifetime')}
        >
          Lifetime
        </button>
        <button
          type="button"
          className={`vault-btn small${span === 'last30' ? ' primary' : ' ghost'}`}
          aria-pressed={span === 'last30'}
          onClick={() => setSpan('last30')}
        >
          Last 30 Days
        </button>
      </div>
      <div className="flow-columns">
        <FlowSide
          title="Spent"
          tone="spent"
          lines={flow.spent}
          total={spentTotal}
          span={span}
          nothing={
            span === 'lifetime' ? 'Nothing Spent Yet.' : 'Nothing Spent In The Last 30 Days.'
          }
        />
        <FlowSide
          title="Earned"
          tone="earned"
          lines={flow.earned}
          total={earnedTotal}
          span={span}
          nothing={
            span === 'lifetime' ? 'Nothing Earned Yet.' : 'Nothing Earned In The Last 30 Days.'
          }
        />
      </div>
    </div>
  );
}
