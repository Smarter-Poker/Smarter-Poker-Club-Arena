import { useRef, useState } from 'react';
import {
  captureCashoutReceiptCheck,
  recoverCashoutOperation,
  assertCashoutStartCurrent,
  type CashoutStart,
} from '../../services/CashoutOperation';

interface RetainedCheck {
  key: string;
  amount: number;
  action: string;
  original: CashoutStart;
  message: string;
}

/** In-memory, original-view recovery only. No personal intent is persisted here. */
export function useCashoutReceiptChecks(isCurrent: () => boolean, onFound: () => void) {
  const owner = useRef(isCurrent);
  const records = useRef(new Map<string, RetainedCheck>());
  const busy = useRef(new Map<string, symbol>());
  const [, redraw] = useState(0);
  if (owner.current !== isCurrent) {
    owner.current = isCurrent;
    records.current = new Map();
    busy.current = new Map();
  }
  const scope = isCurrent;
  const current = () => owner.current === scope && scope();
  const refresh = () => {
    if (current()) redraw((value) => value + 1);
  };
  return {
    cards: current()
      ? [...records.current.values()].map((entry) => ({
          ...entry,
          busy: busy.current.has(entry.key),
        }))
      : [],
    retain: (key: string, amount: number, action: string, original: CashoutStart) => {
      if (!current()) return;
      // The opaque original holds the complete canonical actor/action/target,
      // player/club/amount/note and durable generation. Display fields grant no authority.
      records.current.set(key, {
        key,
        amount,
        action,
        original,
        message: 'The Outcome Is Unconfirmed. Check The Original Receipt.',
      });
      refresh();
    },
    check: async (key: string) => {
      if (!current() || busy.current.has(key)) return;
      const retained = records.current.get(key);
      if (!retained) return;
      const token = Symbol('receipt-check');
      busy.current.set(key, token);
      refresh();
      try {
        const start = captureCashoutReceiptCheck(retained.original, current);
        const outcome = await recoverCashoutOperation(start);
        assertCashoutStartCurrent(start);
        if (!current() || records.current.get(key) !== retained) return;
        if (outcome.found) {
          records.current.delete(key);
          onFound();
        } else {
          retained.message =
            'No Verified Receipt Was Found For This Operation. No New Payment Was Sent.';
        }
      } catch {
        if (current() && records.current.get(key) === retained) {
          retained.message =
            'The Receipt Could Not Be Verified. The Original Operation Is Still Unconfirmed.';
        }
      } finally {
        if (busy.current.get(key) === token) busy.current.delete(key);
        refresh();
      }
    },
  };
}

export function CashoutReceiptChecks({
  checks,
}: {
  checks: ReturnType<typeof useCashoutReceiptChecks>;
}) {
  if (!checks.cards.length) return null;
  return (
    <section aria-label="Unconfirmed Cashout Outcomes">
      {checks.cards.map((card) => (
        <div key={card.key} role="status">
          <strong>
            {card.action}: {card.amount.toLocaleString()} Chips
          </strong>
          <p>{card.message}</p>
          <button type="button" disabled={card.busy} onClick={() => void checks.check(card.key)}>
            {card.busy ? 'Checking Receipt...' : 'Check Receipt'}
          </button>
        </div>
      ))}
    </section>
  );
}
