/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP TRANSFER MODAL — Cashier-Based Chip Distribution
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ALL chip movements happen through the Cashier via respective wallets.
 * Uses ChipFlowService for atomic transfers with full audit trail.
 *
 * Supports:
 * - Union Owner → Club Owner
 * - Club Owner → Agent
 * - Agent → Sub-Agent
 * - Agent → Player
 * - Club Owner → Player (direct)
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { ChipFlowService } from '../../services/ChipFlowService';
import { WalletService } from '../../services/WalletService';
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
  const [isLoadingRecipients, setIsLoadingRecipients] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [senderBalance, setSenderBalance] = useState<number>(0);
  const [senderRole, setSenderRole] = useState<string>('member');
  const [clubName, setClubName] = useState<string>('');
  const [mounted, setMounted] = useState(false);

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
      // Get sender's PLAYER wallet balance
      const balance = await WalletService.getPlayerBalance(user.id);
      setSenderBalance(balance);

      // Get sender's role in this club
      const resolvedId = await resolveClubUUID(clubId);
      const { data: member } = await supabase
        .from('club_members')
        .select('role')
        .eq('club_id', resolvedId)
        .eq('user_id', user.id)
        .maybeSingle();
      setSenderRole(member?.role || 'member');

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
      const { data: wallets } = await supabase
        .from('wallets')
        .select('user_id, balance')
        .in('user_id', recipientIds)
        .eq('wallet_type', 'PLAYER');

      const walletMap: Record<string, number> = {};
      (wallets || []).forEach((w: any) => {
        walletMap[w.user_id] = w.balance;
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

    if (senderRole === 'owner') {
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
    if (transferAmount > senderBalance) {
      setError(`Insufficient balance. Available: ${senderBalance.toLocaleString()}`);
      return;
    }
    if (!user?.id) return;

    setIsLoading(true);
    setError(null);

    try {
      const recipientData = selectedRecipientData;
      const description = note || getTransferDescription();

      // Use ChipFlowService for proper atomic wallet transfer
      if (
        senderRole === 'owner' &&
        (recipientData?.role === 'agent' || recipientData?.role === 'super_agent')
      ) {
        await ChipFlowService.clubToAgent(
          user.id,
          selectedRecipient,
          clubId,
          transferAmount,
          recipientData?.username || 'Agent',
          clubName
        );
      } else if (senderRole === 'owner') {
        await ChipFlowService.clubToPlayer(
          user.id,
          selectedRecipient,
          transferAmount,
          recipientData?.username || 'Player',
          clubName
        );
      } else {
        // Agent → Player or Agent → Sub-Agent
        await ChipFlowService.agentToPlayer(
          user.id,
          selectedRecipient,
          transferAmount,
          user.username || 'Agent',
          recipientData?.username || 'Player',
          clubName
        );
      }

      setSuccess(`Transferred ${transferAmount.toLocaleString()} to ${recipientData?.username}`);
      if (isMounted.current) toast.success(`Transferred ${transferAmount.toLocaleString()} chips`);
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
      if (isMounted.current) setError(safeErrorMessage(err, 'Transfer failed. Please try again.'));
    }
    setIsLoading(false);
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
          <span>Your Balance:</span>
          <span className="balance-amount">{senderBalance.toLocaleString()}</span>
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
                max={senderBalance}
                step="1"
              />
            </div>
            <div className="quick-amounts">
              {quickAmounts.map((val) => (
                <button key={val} type="button" onClick={() => setAmount(String(val))}>
                  {val.toLocaleString()}
                </button>
              ))}
              <button type="button" onClick={() => setAmount(String(senderBalance))}>
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
                  {senderBalance.toLocaleString()} →{' '}
                  {Math.max(0, senderBalance - parseFloat(amount)).toLocaleString()}
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
              placeholder="e.g., Weekly allocation, player funding..."
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
