import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { supabase } from '../lib/supabase';
import { diamondTxLabel } from '../components/wallet/DiamondWalletModal';
import { reportError } from '../utils/errorReporter';

/**
 * ONE PAGED READ OF `diamond_transactions`, USED BY BOTH SIDES OF THE WALLET.
 *
 * The Receive pane and the Send pane are the same query in two directions, and
 * before this hook existed only the Receive half was written - as a flat
 * `.limit(25)` with no continuation and nothing on screen admitting the cut.
 * Measured on production 2026-09-05: 645 players hold diamond credits, 6 hold
 * more than 25, and the longest ledger is 390 - so one player could reach 25 of
 * their 390 credits with no route to the rest.
 *
 * It lives in a hook rather than twice in the page so the two panes cannot
 * drift, and so the four things below are decided once.
 *
 *  1. THE PAGE ORDER CARRIES A UNIQUE TIEBREAKER. `created_at` alone is not an
 *     order: rows sharing a timestamp may come back in any sequence, so across
 *     a `.range()` seam one row is served twice and another skipped entirely.
 *     Measured here, not defensive - production holds 8 groups of credits
 *     written at an identical `created_at`, the largest of them 29 rows, which
 *     is larger than a whole page. `id` is a uuid in a unique index, so
 *     ordering by it second makes the sequence total.
 *
 *  2. THE NEXT PAGE STARTS FROM WHAT IS ON SCREEN, never from a page counter.
 *     `refresh` prepends newly arrived rows, so after one lands the Nth page no
 *     longer begins at N * pageSize and a counter re-serves a shifted row.
 *
 *  3. A REFRESH MERGES, IT DOES NOT RESET. These panes refresh themselves when
 *     a balance changes; re-reading as a reset would collapse a player who had
 *     paged down to 100 rows back to 25 the moment a diamond arrived, which is
 *     a worse defect than the cap this replaces.
 *
 *  4. A FAILED LATER PAGE KEEPS THE EARLIER ONES. Only the first read has
 *     nothing to preserve, so only the first read may blank the list.
 */

/** PostgREST's page for both panes. */
export const DIAMOND_LEDGER_PAGE = 25;

/**
 * The out-direction is a set of kinds rather than `amount < 0`, because the
 * refund of a failed gift is POSITIVE and still belongs to the send story - the
 * sender has to be able to see that their diamonds came back. Read from the
 * transfer route (`pages/api/store/diamond-transfer.js`), never guessed: it
 * writes `diamond_gift_sent` on the debit and `diamond_gift_refund` when the
 * recipient's credit fails after the sender has already been charged.
 */
const SENT_KINDS = ['diamond_gift_sent', 'live_gift_sent', 'diamond_gift_refund'] as const;

export interface DiamondLedgerRow {
  id: string;
  label: string;
  description: string;
  amount: number;
  createdAt: string;
  /**
   * The other player in a gift, when the row names one:
   * `metadata.recipient_id` on a send, `metadata.sender_id` on a receipt
   * (both written by `send_wallet_diamond_transfer`). Null for a claim, a
   * purchase or a reconciliation, which have no counterparty.
   */
  counterpartyId: string | null;
}

/**
 *  in   every credit that landed - the Receive pane
 *  out  every gift sent, and any refund of one - the Send pane
 */
export type DiamondLedgerDirection = 'in' | 'out';

export type DiamondLedgerMode = 'reset' | 'more' | 'refresh';

export interface DiamondLedger {
  /** `null` until the first read resolves, so "loading" and "empty" differ. */
  rows: DiamondLedgerRow[] | null;
  error: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  load: (mode?: DiamondLedgerMode) => Promise<void>;
}

export function useDiamondLedger(
  userId: string | undefined,
  direction: DiamondLedgerDirection,
  isMounted: RefObject<boolean>
): DiamondLedger {
  const [rows, setRows] = useState<DiamondLedgerRow[] | null>(null);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  /* Mirrors `rows` so `load` can read the current length without taking `rows`
     as a dependency: `load` is what the callers' balance subscriptions are
     built from, and a new identity on every row change would tear those
     subscriptions down and rebuild them on every diamond that moved. */
  const rowsRef = useRef<DiamondLedgerRow[]>([]);
  /* Last write wins across overlapping reads. A refresh fired by an arriving
     diamond can resolve after a Load More that was requested first; without
     this the older response overwrites the newer list. */
  const seqRef = useRef(0);

  // A different player, or a different direction, is a different ledger.
  useEffect(() => {
    seqRef.current += 1;
    rowsRef.current = [];
    setRows(null);
    setError(false);
    setHasMore(false);
    setLoadingMore(false);
  }, [userId, direction]);

  const load = useCallback(
    async (mode: DiamondLedgerMode = 'reset') => {
      if (!userId) return;
      const seq = ++seqRef.current;
      const from = mode === 'more' ? rowsRef.current.length : 0;
      if (mode === 'more') setLoadingMore(true);
      try {
        let query = supabase
          .from('diamond_transactions')
          /* `type` AND `transaction_type`: the older rows carry their kind in
             `type` (signup_bonus, reconciliation), the newer in
             `transaction_type`. Reading one column blanks half the ledger. */
          .select('id, type, transaction_type, amount, description, created_at, metadata')
          .eq('user_id', userId);

        if (direction === 'in') {
          query = query.gt('amount', 0);
        } else {
          const list = SENT_KINDS.join(',');
          // Same both-columns reason as the select above, expressed as a filter.
          query = query.or(`transaction_type.in.(${list}),type.in.(${list})`);
        }

        const { data, error: readError } = await query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + DIAMOND_LEDGER_PAGE - 1);
        if (readError) throw readError;

        const page: DiamondLedgerRow[] = (data || []).map((tx) => {
          const kind = (tx.transaction_type as string | null) || (tx.type as string | null);
          const meta = (tx.metadata && typeof tx.metadata === 'object' ? tx.metadata : {}) as {
            recipient_id?: unknown;
            sender_id?: unknown;
          };
          const other = direction === 'out' ? meta.recipient_id : meta.sender_id;
          return {
            id: String(tx.id),
            label: diamondTxLabel(kind),
            description: String(tx.description || ''),
            amount: Number(tx.amount) || 0,
            createdAt: String(tx.created_at),
            counterpartyId: typeof other === 'string' && other ? other : null,
          };
        });

        if (!isMounted.current || seq !== seqRef.current) return;

        setRows((prev) => {
          const base = mode === 'reset' ? [] : prev || [];
          /* De-dupe by id in both directions. A row arriving between two pages
             shifts the window, and the same row would otherwise be rendered
             twice under a duplicate React key. */
          const seen = new Set(base.map((r) => r.id));
          const fresh = page.filter((r) => !seen.has(r.id));
          const merged = mode === 'refresh' ? [...fresh, ...base] : [...base, ...fresh];
          rowsRef.current = merged;
          return merged;
        });

        /* A short page is the end of the ledger. NOT recomputed on `refresh`:
           that reads page one, which is full whenever the ledger is long, and
           would re-offer Load More to a reader already holding every row. */
        if (mode !== 'refresh') setHasMore(page.length === DIAMOND_LEDGER_PAGE);
        setError(false);
      } catch (err) {
        reportError(err, `useDiamondLedger.${direction}`);
        if (!isMounted.current || seq !== seqRef.current) return;
        if (mode === 'reset') {
          rowsRef.current = [];
          setRows([]);
        }
        setError(true);
      } finally {
        if (isMounted.current && seq === seqRef.current) setLoadingMore(false);
      }
    },
    [userId, direction, isMounted]
  );

  return { rows, error, hasMore, loadingMore, load };
}
