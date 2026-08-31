/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP TRANSFER MODAL — Cashier-Based Chip Distribution
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-25, binding: "Any chips sent or claimed back transact from the
 * Agent Wallet." And 2026-08-31: "CHIPS MUST FLOW FROM THE MAIN BANK TO THE
 * AGENT WALLET TO SEND OUT TO AGENTS AND PLAYERS."
 *
 * THIS MODAL WAS A FOURTH MONEY PATH, AND IT MOVED THE WRONG ACCOUNTS.
 * Until phase 3 it called ChipFlowService.clubToAgent / clubToPlayer /
 * agentToPlayer, all three of which are peer-to-peer moves between two users'
 * PLAYER wallets on atomic_chip_transfer:
 *
 *   - clubToAgent debited the OWNER'S PERSONAL wallet, never clubs.chip_treasury,
 *     despite its name. The club bank was untouched by the "club bank" send;
 *   - agentToPlayer debited the agent's own PLAYER wallet rather than
 *     agents.agent_wallet_balance, which its own doc comment admitted;
 *   - the balance it validated against, and displayed, was the viewer's GLOBAL
 *     player wallet, which is not the account any of these sends debited;
 *   - no idempotency key, so a response lost on the way back was
 *     indistinguishable from a send that never happened and the obvious retry
 *     sent a second time;
 *   - no downline check, so the only scoping was a recipient list that offered
 *     an agent the entire club;
 *   - no result check, so a refusal from the RPC still printed "Transferred".
 *
 * CashierPage.tsx:1430-1455 documented this exact bug when the Cashier was
 * fixed on 2026-08-27. The Cashier was fixed and this modal was left behind.
 *
 * It is now the same two calls every other surface makes. The four bank roles
 * spend the CLUB BANK (fn_club_bank_send, self-send permitted - that is how an
 * owner funds their own float); the three agent roles spend their AGENT WALLET
 * (fn_agent_wallet_send, downline enforced server-side). Both derive the
 * destination from the recipient's role, carry a uuid op_id, write one
 * chip_transactions row, and open a ten minute clawback window.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { CLUB_BANK_ROLES, canHoldAgentWallet } from '../wallet/walletRows';
import { normaliseRole } from '../../types/clubRoles';
import { uuid } from '../../utils/uuid';
import { resolveClubIdFilter, resolveClubUUID } from '../../utils/clubIdResolver';
import './ChipTransferModal.css';
import { reportError } from '../../utils/errorReporter';

import { safeErrorMessage } from '../../utils/safeErrorMessage';
interface Recipient {
  id: string;
  username: string;
  avatar_url: string;
  role: string;
  balance: number;
}

interface ChipTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  clubId: string;
  recipientId?: string;
  onTransferComplete?: () => void;
}

export default function ChipTransferModal({
  isOpen,
  onClose,
  clubId,
  recipientId,
  onTransferComplete,
}: ChipTransferModalProps) {
  const isMounted = useIsMounted();
  const { user } = useAuthUser();
  const toast = useToast();

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [selectedRecipient, setSelectedRecipient] = useState<string>(recipientId || '');
  const [amount, setAmount] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  // Ref, not isLoading: a same-frame double tap must not run two transfers.
  const transferInFlightRef = useRef(false);
  const [isLoadingRecipients, setIsLoadingRecipients] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  /* null means UNKNOWN, not zero. senderBalance gates the send below, and a
     failed read that collapses to 0 blocks a send the server would allow. */
  const [senderBalance, setSenderBalance] = useState<number | null>(null);
  const [senderRole, setSenderRole] = useState<string>('member');
  const [clubName, setClubName] = useState<string>('');
  const [mounted, setMounted] = useState(false);

  /* A PER-INTENT idempotency key, the same shape CashierPage uses. A key minted
     inside the call protects nothing: the dangerous shape is commit, lost
     response, user retry - and that retry must present the SAME key so the
     server replays instead of debiting twice. It is held across a failed
     attempt and rotated only when the recipient or the amount changes. */
  const sendOpIdRef = useRef<string>(uuid());
  const opIdSeedRef = useRef<string>('');

  /* The four bank roles spend the club treasury; everyone else spends their own
     agent wallet. walletRows is the one place this rule lives, and
     fn_can_use_club_bank enforces the same four roles server-side. */
  const viaClubBank = CLUB_BANK_ROLES.includes(normaliseRole(senderRole));
  const sourceLabel = viaClubBank ? 'Club Bank' : 'Agent Wallet';

  useEffect(() => {
    if (isOpen) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [isOpen]);

  // Load sender's wallet balance and role
  useEffect(() => {
    if (!isOpen || !user?.id) return;
    loadSenderInfo();
  }, [isOpen, user?.id, clubId]);

  // Load recipients when modal opens
  useEffect(() => {
    if (!isOpen || !user?.id) return;
    if (recipientId) {
      setSelectedRecipient(recipientId);
    }
    loadRecipients();
  }, [isOpen, user?.id, clubId, recipientId]);

  const loadSenderInfo = async () => {
    if (!user?.id) return;
    try {
      /* THE BALANCE SHOWN MUST BE THE ACCOUNT THAT GETS DEBITED.
         This used to read WalletService.readPlayerBalance - the viewer's GLOBAL
         player wallet - and then validate the send against it, while the send
         itself moved a different account entirely. An agent with an empty
         personal wallet and a funded agent wallet was refused by their own
         browser; the reverse let a send through that the server then refused.
         The role decides the account, and the account decides the number.

         A failed read stays null (UNKNOWN) rather than collapsing to zero: the
         guard below refuses only on a number it actually has, so a network blip
         can never block a send the server would have allowed. */
      const resolvedId = await resolveClubUUID(clubId);
      const { data: member } = await supabase
        .from('club_members')
        .select('role')
        .eq('club_id', resolvedId)
        .eq('user_id', user.id)
        .maybeSingle();
      const role = member?.role || 'member';
      setSenderRole(role);

      if (CLUB_BANK_ROLES.includes(normaliseRole(role))) {
        const { data: bank, error: bankErr } = await supabase
          .from('clubs')
          .select('chip_treasury')
          .eq('id', resolvedId)
          .maybeSingle();
        if (!bankErr) setSenderBalance(Number(bank?.chip_treasury ?? 0) || 0);
      } else {
        const { data: float_, error: floatErr } = await supabase
          .from('agents')
          .select('agent_wallet_balance')
          .eq('club_id', resolvedId)
          .eq('user_id', user.id)
          .maybeSingle();
        // No row is a float of zero. A row we could not READ is unknown.
        if (!floatErr) setSenderBalance(Number(float_?.agent_wallet_balance ?? 0) || 0);
      }

      // Get club name
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data: club } = await supabase
        .from('clubs')
        .select('name')
        .eq(clubCol, clubVal)
        .maybeSingle();
      setClubName(club?.name || '');
    } catch (err) {
      reportError(err, 'ChipTransferModal.Failed_to_load_sender_info');
    }
  };

  const loadRecipients = async () => {
    if (!user?.id) return;
    setIsLoadingRecipients(true);
    try {
      // Get the sender's role to determine who they can send to
      const { data: senderMember } = await supabase
        .from('club_members')
        .select('role')
        .eq('club_id', await resolveClubUUID(clubId))
        .eq('user_id', user.id)
        .maybeSingle();

      const role = senderMember?.role || 'member';

      /* WHO THIS MODAL MAY SEND TO (Dan 2026-08-25, binding):
         "Super Agents, Agents, and Sub Agents should ONLY EVER SEE their
          downlines, and their downline agents' downlines. Nobody else. Owners,
          Co Owners and Admins should see everyone."

         This list used to offer an agent every member of the club, staff and
         owners included, and hand every one of them to a send that
         fn_agent_wallet_send then refuses as out-of-downline. The list and the
         server disagreed, so the modal advertised transfers that could not
         happen. fn_club_cashier_members walks the same recursive
         club_members.agent_id edge that fn_club_cashier_can_transact refuses
         on, and is the same source the Cashier, the Trade grid and the Wallet
         Cashier already read - so all four surfaces and the database now agree
         by construction rather than by four hand-rolled attempts. */
      if (['super_agent', 'agent', 'sub_agent'].includes(normaliseRole(role))) {
        const { data: scoped, error: scopedErr } = await supabase.rpc('fn_club_cashier_members', {
          p_club_id: await resolveClubUUID(clubId),
        });
        if (scopedErr) throw scopedErr;
        const scopedList: Recipient[] = ((scoped || []) as Array<Record<string, unknown>>)
          // fn_agent_wallet_send refuses a self-send outright, so offering it
          // is offering a guaranteed refusal.
          .filter((m) => String(m.user_id) !== user.id)
          .map((m) => ({
            id: String(m.user_id),
            username: String(m.username || m.name || 'Unknown'),
            avatar_url: '',
            role: String(m.role || 'player'),
            balance: Number(m.chip_balance) || 0,
          }));
        setRecipients(scopedList);
        setIsLoadingRecipients(false);
        return;
      }

      let query = supabase
        .from('club_members')
        .select(
          `
                    user_id,
                    role,
                    users:user_id(
                        id,
                        username,
                        avatar_url:arena_avatar_url
                    )
                `
        )
        .eq('club_id', await resolveClubUUID(clubId));

      // Filter recipients based on sender's role in the hierarchy
      if (role === 'owner' || role === 'co_owner' || role === 'admin') {
        // Owner/Admin can send to all roles (including staff, agents, and players)
        query = query.in('role', [
          'owner',
          'co_owner',
          'admin',
          'super_agent',
          'agent',
          'sub_agent',
          'member',
          'player',
        ]);
      } else if (role === 'agent' || role === 'super_agent') {
        // Agents can send to staff, agents, sub-agents, and players
        query = query.in('role', [
          'owner',
          'co_owner',
          'admin',
          'super_agent',
          'agent',
          'sub_agent',
          'member',
          'player',
        ]);
      } else if (role === 'sub_agent') {
        // Sub-agents can send to their players and sub-agents
        query = query.in('role', ['sub_agent', 'member', 'player']);
      }

      const { data, error: queryError } = await query;
      if (queryError) throw queryError;

      // Get wallet balances for all recipients
      const recipientIds = (data || []).map((m: any) => m.users?.id).filter(Boolean);
      /* ═══ THE AGENT WAS SHOWN SIX-DAY-OLD BALANCES (fixed 2026-08-27) ═══
         This read the retired global wallet table, frozen since 2026-08-21,
         to decide what each recipient already holds - the number an agent
         looks at when choosing how many chips to send. Measured that day, one
         player read 3,313,727.73 there against a true 34,818.60. It reads the
         live club-scoped pool now, and scopes to THIS club, which is also the
         only balance that means anything in a club-chip transfer. */
      const { data: wallets } = await supabase
        .from('club_members')
        .select('user_id, chip_balance')
        .in('user_id', recipientIds)
        .eq('club_id', await resolveClubUUID(clubId));

      const walletMap: Record<string, number> = {};
      (wallets || []).forEach((w: any) => {
        walletMap[w.user_id] = Number(w.chip_balance ?? 0) || 0;
      });

      const recipientList: Recipient[] = (data || [])
        .filter((m: any) => m.users?.id)
        .map((m: any) => ({
          id: m.users.id,
          username: m.users.username || 'Unknown',
          avatar_url: m.users.avatar_url || '',
          role: m.role,
          balance: walletMap[m.users.id] || 0,
        }))
        .sort((a: Recipient, b: Recipient) => {
          // Sort: agents first, then players
          const roleOrder: Record<string, number> = {
            owner: 0,
            co_owner: 0,
            admin: 0,
            super_agent: 1,
            agent: 1,
            sub_agent: 2,
            member: 3,
            player: 3,
          };
          return (roleOrder[a.role] || 3) - (roleOrder[b.role] || 3);
        });

      setRecipients(recipientList);
    } catch (err) {
      reportError(err, 'ChipTransferModal.Error_loading_recipients');
      if (isMounted.current) toast.error('Failed to load recipients');
    }
    setIsLoadingRecipients(false);
  };

  const filteredRecipients = useMemo(() => {
    if (!searchQuery.trim()) return recipients;
    const q = searchQuery.trim().toLowerCase();
    return recipients.filter(
      (r) =>
        r.username.toLowerCase().includes(q) ||
        r.role.toLowerCase().includes(q) ||
        (r.id === user?.id && 'you'.includes(q))
    );
  }, [recipients, searchQuery, user?.id]);

  const selectedRecipientData = useMemo(() => {
    return recipients.find((r) => r.id === selectedRecipient);
  }, [recipients, selectedRecipient]);

  const getTransferDescription = () => {
    const recipientData = selectedRecipientData;
    if (!recipientData) return '';
    const recipientLabel =
      recipientData.role === 'agent' || recipientData.role === 'super_agent'
        ? `Agent ${recipientData.username}`
        : recipientData.role === 'sub_agent'
          ? `Sub-Agent ${recipientData.username}`
          : recipientData.username;

    /* THE REASON MUST NAME THE ACCOUNT THAT PAID, because it is written into
       the chip_transactions row and is what somebody reads back months later.
       This asked isClubStaff, which is owner, co-owner and admin - one role
       short of the four that spend the club bank. A SUPER AGENT therefore
       debited the club treasury while the ledger recorded "Agent -> ...:
       player funding", describing the wrong source. It follows the same
       viaClubBank the send itself routes on, so the row and the money cannot
       disagree. */
    if (viaClubBank) {
      return `${clubName} → ${recipientLabel}: chip allocation`;
    }
    return `Agent → ${recipientLabel}: player funding (${clubName})`;
  };

  const handleTransfer = async () => {
    const transferAmount = parseFloat(amount);

    if (!selectedRecipient) {
      setError('Please select a recipient');
      return;
    }
    if (isNaN(transferAmount) || transferAmount <= 0) {
      setError('Please enter a valid amount');
      return;
    }
    if (senderBalance !== null && transferAmount > senderBalance) {
      setError(`Your ${sourceLabel} Only Holds ${senderBalance.toLocaleString()} Chips.`);
      return;
    }
    if (!user?.id) return;
    if (transferInFlightRef.current) return;
    transferInFlightRef.current = true;

    setIsLoading(true);
    setError(null);

    try {
      const recipientData = selectedRecipientData;
      const description = note || getTransferDescription();

      /* ONE MONEY PATH. The route follows the CALLER's role and the
         destination follows the RECIPIENT's, which is what the database does
         with both regardless of what is sent here. */
      const resolvedForSend = (await resolveClubUUID(clubId)) || clubId;

      // Rotate the key only when the intent changes, so a retry of the SAME
      // send replays server-side instead of debiting a second time.
      const seed = `${selectedRecipient}:${transferAmount}`;
      if (opIdSeedRef.current !== seed) {
        opIdSeedRef.current = seed;
        sendOpIdRef.current = uuid();
      }

      const { data: sendData, error: sendError } = await supabase.rpc(
        viaClubBank ? 'fn_club_bank_send' : 'fn_agent_wallet_send',
        {
          p_club_id: resolvedForSend,
          p_to_user_id: selectedRecipient,
          p_amount: transferAmount,
          p_destination: canHoldAgentWallet(recipientData?.role) ? 'agent_wallet' : 'player_wallet',
          p_reason: description,
          p_op_id: sendOpIdRef.current,
        }
      );
      if (sendError) throw sendError;

      /* The RPC reports a refusal as { success: false, error }. The old path
         checked nothing at all, so a refusal still printed "Transferred". */
      const sendRes = (Array.isArray(sendData) ? sendData[0] : sendData) as {
        success?: boolean;
        error?: string;
        replayed?: boolean;
        credit_drawn?: number;
      } | null;
      if (!sendRes?.success) {
        throw new Error(sendRes?.error || 'The Cashier Refused That Transfer');
      }

      // A send funded from the credit line says so, because it is a debt the
      // agent owes back and not float they found in their wallet.
      const drawn = Number(sendRes.credit_drawn ?? 0) || 0;
      const drawnNote = drawn > 0 ? ` (${drawn.toLocaleString()} On Credit)` : '';
      const headline = sendRes.replayed
        ? `That Transfer Had Already Gone Through. ${transferAmount.toLocaleString()} Chips Are With ${recipientData?.username || 'Them'}`
        : `Transferred ${transferAmount.toLocaleString()} To ${recipientData?.username || 'Them'}${drawnNote}`;

      // The intent is spent: the next identical send is a new one.
      opIdSeedRef.current = '';

      setSuccess(headline);
      if (isMounted.current) toast.success(headline);
      setAmount('');
      setNote('');

      // Refresh sender balance
      await loadSenderInfo();

      if (onTransferComplete) onTransferComplete();

      setTimeout(() => {
        onClose();
        setSuccess(null);
      }, 1500);
    } catch (err: any) {
      reportError(err, 'ChipTransferModal.Transfer_error');
      const msg = err instanceof Error ? err.message : err?.message || String(err);
      if (isMounted.current) setError(msg);
    }
    setIsLoading(false);
    transferInFlightRef.current = false;
  };

  const handleClose = () => {
    setError(null);
    setSuccess(null);
    setAmount('');
    setNote('');
    onClose();
  };

  if (!isOpen) return null;

  const quickAmounts = [100, 500, 1000, 5000];

  return (
    <div className="chip-transfer-overlay" onClick={handleClose}>
      <div
        className="chip-transfer-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <div className="chip-transfer-header">
          <h2>Cashier Transfer</h2>
          <button className="close-btn" onClick={handleClose}>
            X
          </button>
        </div>

        <div className="agent-balance">
          {/* Name the account, because it decides what the send can spend and
              which of two RPCs moves it. "Your Balance" was true of neither. */}
          <span>Your {sourceLabel}:</span>
          <span className="balance-amount">
            {senderBalance === null ? 'Unknown' : senderBalance.toLocaleString()}
          </span>
        </div>

        <div className="chip-transfer-form">
          {/* Recipient Selection */}
          {!recipientId && (
            <div className="form-group">
              <label>Send To</label>
              <input
                type="text"
                placeholder="Search Member, Role Or (You)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  marginBottom: '8px',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid #334155',
                  background: '#0f172a',
                  color: '#fff',
                  width: '100%',
                }}
                aria-label="Search Recipients"
              />
              {isLoadingRecipients ? (
                <div className="loading-text">Loading...</div>
              ) : (
                <select
                  value={selectedRecipient}
                  onChange={(e) => setSelectedRecipient(e.target.value)}
                  className="player-select"
                >
                  <option value="">Select Recipient</option>
                  {filteredRecipients.map((r) => {
                    const isSelf = r.id === user?.id;
                    const roleTag =
                      r.role === 'owner'
                        ? '[Owner] '
                        : r.role === 'co_owner'
                          ? '[Co-Owner] '
                          : r.role === 'admin'
                            ? '[Admin] '
                            : r.role === 'super_agent'
                              ? '[Super-Agent] '
                              : r.role === 'agent'
                                ? '[Agent] '
                                : r.role === 'sub_agent'
                                  ? '[Sub-Agent] '
                                  : '';
                    return (
                      <option key={r.id} value={r.id}>
                        {isSelf ? '(You) ' : ''}
                        {roleTag}
                        {r.username} (Bal: {r.balance.toLocaleString()})
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          )}

          {/* Amount Input */}
          <div className="form-group">
            <label>Amount</label>
            <div className="amount-input-wrapper">
              <span className="currency-symbol">◉</span>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                min="0"
                max={senderBalance ?? undefined}
                step="1"
              />
            </div>
            <div className="quick-amounts">
              {quickAmounts.map((val) => (
                <button key={val} type="button" onClick={() => setAmount(String(val))}>
                  {val.toLocaleString()}
                </button>
              ))}
              <button
                type="button"
                disabled={senderBalance === null}
                onClick={() => setAmount(String(senderBalance ?? 0))}
              >
                Max
              </button>
            </div>
          </div>

          {/* Preview */}
          {selectedRecipientData && amount && parseFloat(amount) > 0 && (
            <div className="transfer-preview">
              <div className="preview-row">
                <span>You:</span>
                <span>
                  {(senderBalance ?? 0).toLocaleString()} →{' '}
                  {Math.max(0, (senderBalance ?? 0) - parseFloat(amount)).toLocaleString()}
                </span>
              </div>
              <div className="preview-row">
                <span>{selectedRecipientData.username}:</span>
                <span>
                  {selectedRecipientData.balance.toLocaleString()} →{' '}
                  {(selectedRecipientData.balance + parseFloat(amount)).toLocaleString()}
                </span>
              </div>
            </div>
          )}

          {/* Note Input */}
          <div className="form-group">
            <label>Note (Optional)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="E.G., Weekly Allocation, Player Funding..."
            />
          </div>

          {/* Messages */}
          {error && <div className="message error">{error}</div>}
          {success && <div className="message success">{success}</div>}

          {/* Submit Button */}
          <button
            className="transfer-btn"
            onClick={handleTransfer}
            disabled={isLoading || !selectedRecipient || !amount}
          >
            {isLoading ? 'Processing...' : 'Confirm Transfer'}
          </button>
        </div>
      </div>
    </div>
  );
}
