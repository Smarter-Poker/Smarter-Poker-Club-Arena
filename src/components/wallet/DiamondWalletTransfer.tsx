import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { playerDisplayName } from '../../utils/playerDisplayName';
import { reportError } from '../../utils/errorReporter';

type Request = { recipient: string; name: string; amount: number; key: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function DiamondWalletTransfer({
  userId,
  onComplete,
}: {
  userId: string;
  onComplete: () => void;
}) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const storageKey = 'diamond-transfer:' + userId;
  const [request, setRequest] = useState<Request | null>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      return saved &&
        uuid.test(saved.recipient) &&
        typeof saved.name === 'string' &&
        Number.isSafeInteger(saved.amount) &&
        saved.amount > 0 &&
        uuid.test(saved.key)
        ? saved
        : null;
    } catch {
      return null;
    }
  });
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(Boolean(request));

  async function verify() {
    const id = recipient.trim().toLowerCase();
    const units = Number(amount);
    if (!uuid.test(id) || id === userId || !Number.isSafeInteger(units) || units <= 0) {
      setMessage('Enter A Different Player ID And A Positive Whole Diamond Amount.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, alias, username')
        .eq('id', id)
        .maybeSingle();
      if (!alive.current) return;
      if (error || !data) throw error || new Error('Player Not Found');
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
      if (alive.current) setBusy(false);
    }
  }

  async function send() {
    const next = request || review;
    if (!next || busy) return;
    setBusy(true);
    setMessage('');
    try {
      // Persist before the request. A refresh must retry this identity.
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      setRequest(next);
      const { data, error } = await supabase.rpc('send_wallet_diamond_transfer', {
        p_recipient_id: next.recipient,
        p_amount: next.amount,
        p_message: null,
        p_reference_id: next.key,
      });
      if (!alive.current) return;
      if (error) {
        if (['42501', '22023', 'P0001'].includes(error.code)) {
          sessionStorage.removeItem(storageKey);
          setRequest(null);
          setReview(null);
          setMessage('Transfer Was Refused. Verify The Friend And Amount Before Trying Again.');
          return;
        }
        throw error;
      }
      if (!data || data.success !== true) {
        if (data?.success === false) {
          sessionStorage.removeItem(storageKey);
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
      sessionStorage.removeItem(storageKey);
      setRequest(null);
      setReview(null);
      setMessage(next.amount.toLocaleString() + ' Diamonds Sent To ' + next.name + '.');
      setAmount('');
      onComplete();
    } catch (error) {
      if (!alive.current) return;
      reportError(error, 'DiamondWalletTransfer.Send');
      setMessage('Transfer Not Yet Confirmed. Retry This Transfer To Retrieve Its Receipt.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const confirmation = request || review;
  return (
    <section className="diamond-wallet-transfer" aria-label="Send Diamonds">
      <button
        type="button"
        className="diamond-wallet-modal__buy-btn"
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
              <button type="button" disabled={busy} onClick={() => void send()}>
                {busy
                  ? 'Confirming Transfer...'
                  : request
                    ? 'Retry This Transfer'
                    : 'Confirm Transfer'}
              </button>
              {!request && (
                <button type="button" disabled={busy} onClick={() => setReview(null)}>
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
                  disabled={busy}
                  onChange={(event) => setRecipient(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                Diamond Amount
                <input
                  value={amount}
                  disabled={busy}
                  inputMode="numeric"
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy}>
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
