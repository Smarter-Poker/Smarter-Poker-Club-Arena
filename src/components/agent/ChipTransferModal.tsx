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
import { resolveClubIdFilter, resolveClubUUID } from '../../utils/clubIdResolver';
import './ChipTransferModal.css';

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
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [senderBalance, setSenderBalance] = useState<number>(0);
  const [senderRole, setSenderRole] = useState<string>('member');
  const [clubName, setClubName] = useState<string>('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => setMounted(true), 50);
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
      const { data: wallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', user.id)
        .eq('wallet_type', 'PLAYER')
        .maybeSingle();
      setSenderBalance(wallet?.balance || 0);

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
      console.error('Failed to load sender info:', err);
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
                    users:user_id (
                        id,
                        username,
                        avatar_url
                    )
                `
        )
        .eq('club_id', await resolveClubUUID(clubId))
        .neq('user_id', user.id);

      // Filter recipients based on sender's role in the hierarchy
      if (role === 'owner') {
        // Owner can send to agents, sub-agents, and players
        query = query.in('role', ['agent', 'sub_agent', 'member', 'player']);
      } else if (role === 'agent' || role === 'super_agent') {
        // Agents can send to their sub-agents and players
        query = query.in('role', ['sub_agent', 'member', 'player']);
      } else if (role === 'sub_agent') {
        // Sub-agents can only send to their players
        query = query.in('role', ['member', 'player']);
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
            agent: 0,
            super_agent: 0,
            sub_agent: 1,
            member: 2,
            player: 2,
          };
          return (roleOrder[a.role] || 3) - (roleOrder[b.role] || 3);
        });

      setRecipients(recipientList);
    } catch (err) {
      console.error('Error loading recipients:', err);
      if (isMounted.current) toast.error('Failed to load recipients');
    }
    setIsLoadingRecipients(false);
  };

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
      toast.success(`Transferred ${transferAmount.toLocaleString()} chips`);
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
      console.error('Transfer error:', err);
      if (isMounted.current) setError(err.message || 'Transfer failed. Please try again.');
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
            x
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
              {isLoadingRecipients ? (
                <div className="loading-text">Loading...</div>
              ) : (
                <select
                  value={selectedRecipient}
                  onChange={(e) => setSelectedRecipient(e.target.value)}
                  className="player-select"
                >
                  <option value="">Select recipient</option>
                  {recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.role === 'agent' || r.role === 'super_agent'
                        ? '[Agent] '
                        : r.role === 'sub_agent'
                          ? '[Sub-Agent] '
                          : ''}
                      {r.username} (Bal: {r.balance.toLocaleString()})
                    </option>
                  ))}
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
