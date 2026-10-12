import './DiamondWalletModal.css';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { playerDisplayName } from '../../utils/playerDisplayName';
import { reportError } from '../../utils/errorReporter';
import { DIAMOND_TRANSFER_RECOVERY_PREFIX } from '../../lib/financialJournalKeys';
import { askToSignInAgain, isDeadSessionRefusal } from '../../lib/deadSessionRefusal';

type Request = { recipient: string; name: string; amount: number; key: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The spelling of a whole-diamond amount: digits only, no sign, no exponent. */
const WHOLE_DIAMONDS = /^\d+$/;

export default function DiamondWalletTransfer({
  userId,
  onComplete,
  onBusyChange,
  initialRecipientId = '',
  initiallyOpen = false,
}: {
  userId: string;
  onComplete: () => void;
  initialRecipientId?: string;
  initiallyOpen?: boolean;
  /** Told whenever the transfer RPC is travelling, so the wallet sheet around
      this form can hold its close paths shut (launch audit D-13). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const storageKey = DIAMOND_TRANSFER_RECOVERY_PREFIX + userId;
  const recoveryError = useRef(false);
  const [request, setRequest] = useState<Request | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey) ?? sessionStorage.getItem(storageKey);
      const saved = JSON.parse(raw || 'null');
      const valid =
        saved &&
        uuid.test(saved.recipient) &&
        typeof saved.name === 'string' &&
        Number.isSafeInteger(saved.amount) &&
        saved.amount > 0 &&
        saved.amount <= 2147483647 &&
        uuid.test(saved.key)
          ? saved
          : null;
      if (raw && !valid) recoveryError.current = true;
      return valid;
    } catch {
      recoveryError.current = true;
      return null;
    }
  });
  const [recipient, setRecipient] = useState(initialRecipientId);
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState(
    recoveryError.current
      ? 'Saved Transfer Could Not Be Read. Sending Is Locked To Preserve Its Original Identity.'
      : ''
  );
  const [open, setOpen] = useState(Boolean(request) || initiallyOpen);
  /* Only the SEND is reported: verifying a friend moves nothing. */
  const [sending, setSending] = useState(false);
  useEffect(() => {
    onBusyChange?.(sending);
  }, [sending, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  async function verify() {
    if (busyRef.current || recoveryError.current) return;
    const id = recipient.trim().toLowerCase();
    const spelled = amount.trim();
    const units = Number(spelled);
    /* The spelling is inspected as well as the value (launch audit D-15):
       Number('1e3') is a safe integer, so "1e3" sent a thousand diamonds the
       typist never saw written out. */
    if (
      !uuid.test(id) ||
      id === userId ||
      !WHOLE_DIAMONDS.test(spelled) ||
      !Number.isSafeInteger(units) ||
      units <= 0 ||
      units > 2147483647
    ) {
      setMessage('Enter A Different Player ID And A Positive Whole Diamond Amount.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, alias, username, status')
        .eq('id', id)
        .maybeSingle();
      if (!alive.current) return;
      if (error || !data) throw error || new Error('Player Not Found');
      if (data.status === 'deleted') {
        setMessage('This Player Is No Longer Available.');
        return;
      }
      const { data: friendship, error: friendshipError } = await supabase
        .from('friendships')
        .select('id')
        .eq('status', 'accepted')
        .or(
          'and(user_id.eq.' +
            userId +
            ',friend_id.eq.' +
            id +
            '),and(user_id.eq.' +
            id +
            ',friend_id.eq.' +
            userId +
            ')'
        )
        .limit(1);
      if (!alive.current) return;
      if (friendshipError) throw friendshipError;
      if (!friendship?.length) {
        setMessage('Choose An Accepted Friend.');
        return;
      }
      setReview({
        recipient: id,
        name: playerDisplayName(data),
        amount: units,
        key: crypto.randomUUID(),
      });
    } catch (error) {
      if (!alive.current) return;
      reportError(error, 'DiamondWalletTransfer.Verify');
      setMessage('Could Not Verify This Friend. Please Try Again.');
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function retireOriginalRequest(key: string) {
    // A late replay may arrive after another tab has begun a new transfer.
    // Retire only this request, never the next tab's outstanding identity.
    for (const store of [localStorage, sessionStorage]) {
      try {
        const raw = store.getItem(storageKey);
        if (raw && JSON.parse(raw).key === key) store.removeItem(storageKey);
      } catch {
        /* A retained identity still replays its original receipt. */
      }
    }
  }

  async function send() {
    const next = request || review;
    if (!next || busyRef.current || recoveryError.current) return;
    busyRef.current = true;
    setBusy(true);
    setSending(true);
    setMessage('');
    let submitted = false;
    try {
      // Persist before the request. A refresh must retry this identity.
      // Only identifiers and amount survive sign-out, never a friend's name.
      if (!navigator.locks) throw new Error('Safe Transfer Storage Is Unavailable');
      await navigator.locks.request(storageKey, { mode: 'exclusive' }, () => {
        const saved = JSON.stringify({ ...next, name: 'This Player' });
        const existing = localStorage.getItem(storageKey);
        if (existing && JSON.parse(existing).key !== next.key)
          throw new Error('Another Transfer Needs Verification First');
        localStorage.setItem(storageKey, saved);
        if (localStorage.getItem(storageKey) !== saved)
          throw new Error('Transfer Identity Could Not Be Saved');
      });
      if (!alive.current) return;
      setRequest(next);
      submitted = true;
      const { data, error } = await supabase.rpc('send_wallet_diamond_transfer', {
        p_recipient_id: next.recipient,
        p_amount: next.amount,
        p_message: null,
        p_reference_id: next.key,
      });
      if (!alive.current) return;
      if (error) {
        // This refusal follows receipt lookup, proving no transfer committed.
        // Session and other errors cannot resolve a previous lost response.
        if (error.code === '42501' && error.message === 'accepted_friend_required') {
          retireOriginalRequest(next.key);
          setRequest(null);
          setReview(null);
          setMessage('Transfer Was Refused. Verify The Friend And Amount Before Trying Again.');
          return;
        }
        throw error;
      }
      if (!data || data.success !== true) {
        if (data?.success === false) {
          retireOriginalRequest(next.key);
          setRequest(null);
          setReview(null);
          setMessage(data.error || 'Transfer Was Refused.');
          return;
        }
        throw new Error('Transfer Receipt Missing');
      }
      if (
        data.sender_id !== userId ||
        data.recipient_id !== next.recipient ||
        data.request_id !== next.key ||
        data.amount !== next.amount
      ) {
        throw new Error('Transfer Receipt Does Not Match');
      }
      retireOriginalRequest(next.key);
      setRequest(null);
      setReview(null);
      setMessage(next.amount.toLocaleString() + ' Diamonds Sent To ' + next.name + '.');
      setAmount('');
      onComplete();
    } catch (error) {
      if (!alive.current) return;
      reportError(error, 'DiamondWalletTransfer.Send');
      if (!submitted) {
        setMessage('No New Request Was Submitted. Saved Transfer Keys Are Preserved.');
      } else if (isDeadSessionRefusal(error)) {
        // Phase 11 line 7: the saved request stays; after signing in, Retry
        // sends the same key and retrieves the receipt of anything that ran.
        setMessage(
          'Your Session Has Ended. Sign In Again, Then Retry This Transfer To Retrieve Its Receipt.'
        );
        askToSignInAgain('money:diamond_transfer');
      } else {
        setMessage('Transfer Not Yet Confirmed. Retry This Transfer To Retrieve Its Receipt.');
      }
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        setSending(false);
      }
    }
  }

  const confirmation = request || review;
  return (
    <section className="diamond-wallet-transfer" aria-label="Send Diamonds">
      <button
        type="button"
        className="diamond-wallet-modal__buy-btn"
        disabled={busy || recoveryError.current}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Send Diamonds
      </button>
      {open && (
        <>
          <p>
            Send To An Accepted Friend. Game Custody And Purchased Refund Collateral Stay Protected.
          </p>
          {confirmation ? (
            <div>
              <p>
                Send {confirmation.amount.toLocaleString()} Diamonds To{' '}
                <strong>{confirmation.name}</strong>?
              </p>
              <p>Player ID: {confirmation.recipient}</p>
              <button
                type="button"
                disabled={busy || recoveryError.current}
                onClick={() => void send()}
              >
                {busy
                  ? 'Confirming Transfer...'
                  : request
                    ? 'Retry This Transfer'
                    : 'Confirm Transfer'}
              </button>
              {!request && (
                <button
                  type="button"
                  disabled={busy || recoveryError.current}
                  onClick={() => setReview(null)}
                >
                  Edit
                </button>
              )}
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              <label>
                Friend Player ID
                <input
                  value={recipient}
                  disabled={busy || recoveryError.current}
                  onChange={(event) => setRecipient(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                Diamond Amount
                <input
                  value={amount}
                  disabled={busy || recoveryError.current}
                  inputMode="numeric"
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy || recoveryError.current}>
                {busy ? 'Verifying Friend...' : 'Review Transfer'}
              </button>
            </form>
          )}
          {message && <p role="status">{message}</p>}
        </>
      )}
    </section>
  );
}
