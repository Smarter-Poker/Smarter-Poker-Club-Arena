import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import './ClubBankCashierModal.css'; // Reuse existing styles
import { useAuthUser } from '../../hooks/useAuthUser';

interface PromoWalletCashierModalProps {
  isOpen: boolean;
  onClose: () => void;
  clubId: string;
}

type DestinationWallet = 'agent_wallet' | 'promo_wallet' | 'player_wallet' | 'club_bank';
type RecipientType = 'member' | 'club';

interface Member {
  user_id: string;
  name: string;
  role: string;
  status: string;
  chip_balance: number;
}

interface Club {
  id: string;
  name: string;
}

export function PromoWalletCashierModal({ isOpen, onClose, clubId }: PromoWalletCashierModalProps) {
  const { user } = useAuthUser();
  const [promoBalance, setPromoBalance] = useState<number>(0);
  const [unionId, setUnionId] = useState<string | null>(null);
  const [recipientType, setRecipientType] = useState<RecipientType>('member');

  const [destination, setDestination] = useState<DestinationWallet>('player_wallet');
  const [members, setMembers] = useState<Member[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);

  const [search, setSearch] = useState('');
  const [recipientMember, setRecipientMember] = useState<Member | null>(null);
  const [recipientClub, setRecipientClub] = useState<Club | null>(null);

  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !user?.id) return;

    // Load agent's promo balance and club's union
    const loadState = async () => {
      const { data: c } = await supabase.from('clubs').select('union_id').eq('id', clubId).single();
      setUnionId(c?.union_id || null);

      const { data: a } = await supabase
        .from('club_agents')
        .select('promo_wallet_balance')
        .eq('club_id', clubId)
        .eq('user_id', user.id)
        .single();
      setPromoBalance(Number(a?.promo_wallet_balance) || 0);

      // Load clubs if in union
      if (c?.union_id) {
        const { data: uClubs } = await supabase
          .from('clubs')
          .select('id, name')
          .eq('union_id', c.union_id);
        setClubs(uClubs || []);
      }

      // Load members
      if (c?.union_id) {
        // Load all union members
        const { data: unionMembers } = await supabase
          .from('club_members')
          .select(
            'user_id, role, status, chip_balance, profiles(display_name, username, full_name), clubs!inner(union_id)'
          )
          .eq('clubs.union_id', c.union_id)
          .in('status', ['active', 'approved']);

        if (unionMembers) {
          const mapped = unionMembers.map((m: any) => ({
            user_id: m.user_id,
            name:
              m.profiles?.display_name ||
              m.profiles?.username ||
              m.profiles?.full_name ||
              'Unknown',
            role: m.role,
            status: m.status,
            chip_balance: Number(m.chip_balance) || 0,
          }));
          setMembers(mapped);
        }
      } else {
        // Load standalone club members
        const { data: clubMembers } = await supabase
          .from('club_members')
          .select(
            'user_id, role, status, chip_balance, profiles(display_name, username, full_name)'
          )
          .eq('club_id', clubId)
          .in('status', ['active', 'approved']);

        if (clubMembers) {
          const mapped = clubMembers.map((m: any) => ({
            user_id: m.user_id,
            name:
              m.profiles?.display_name ||
              m.profiles?.username ||
              m.profiles?.full_name ||
              'Unknown',
            role: m.role,
            status: m.status,
            chip_balance: Number(m.chip_balance) || 0,
          }));
          setMembers(mapped);
        }
      }
    };

    loadState();
  }, [isOpen, clubId, user?.id]);

  const filteredMembers = useMemo(() => {
    if (!search) return members;
    const q = search.toLowerCase();
    return members.filter((m) => m.name.toLowerCase().includes(q));
  }, [members, search]);

  const filteredClubs = useMemo(() => {
    if (!search) return clubs;
    const q = search.toLowerCase();
    return clubs.filter((c) => c.name.toLowerCase().includes(q));
  }, [clubs, search]);

  if (!isOpen) return null;

  const onSend = async () => {
    const numAmount = parseFloat(amount);
    if (!numAmount || numAmount <= 0) return setError('Enter a valid amount');
    if (numAmount > promoBalance) return setError('Insufficient Promo Balance');

    if (recipientType === 'member' && !recipientMember) return setError('Select a member');
    if (recipientType === 'club' && !recipientClub) return setError('Select a club');

    setSending(true);
    setError(null);

    const { data, error: rpcErr } = await supabase.rpc('fn_promo_wallet_send', {
      p_club_id: clubId,
      p_to_user_id: recipientType === 'member' ? recipientMember?.user_id : null,
      p_to_club_id: recipientType === 'club' ? recipientClub?.id : null,
      p_amount: numAmount,
      p_destination: destination,
      p_reason: reason || 'Promo Distribution',
    });

    setSending(false);

    if (rpcErr) {
      setError(rpcErr.message);
    } else if (data && !data.success) {
      setError(data.error);
    } else {
      setPromoBalance(data.balance_after);
      setAmount('');
      setRecipientMember(null);
      setRecipientClub(null);
      setSearch('');
      onClose();
    }
  };

  return (
    <div className="cb-cashier-overlay" onClick={onClose}>
      <div className="cb-cashier-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cb-cashier-header">
          <h2>Promo Wallet Cashier</h2>
          <button className="cb-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="cb-cashier-body">
          <div className="cb-bank-stat">
            <div className="cb-bank-label">Your Promo Balance</div>
            <div className="cb-bank-value">
              {promoBalance.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
          </div>

          <div className="cb-dest-select">
            <label>Recipient Type</label>
            <div className="cb-dest-cards">
              <div
                className={`cb-dest-card ${recipientType === 'member' ? 'active' : ''}`}
                onClick={() => {
                  setRecipientType('member');
                  setDestination('player_wallet');
                }}
              >
                <div className="cb-dest-title">Member</div>
              </div>
              {unionId && (
                <div
                  className={`cb-dest-card ${recipientType === 'club' ? 'active' : ''}`}
                  onClick={() => {
                    setRecipientType('club');
                    setDestination('club_bank');
                  }}
                >
                  <div className="cb-dest-title">Club Treasury</div>
                </div>
              )}
            </div>
          </div>

          {recipientType === 'member' && (
            <div className="cb-dest-select">
              <label>Destination Wallet</label>
              <div className="cb-dest-cards">
                <div
                  className={`cb-dest-card ${destination === 'player_wallet' ? 'active' : ''}`}
                  onClick={() => setDestination('player_wallet')}
                >
                  <div className="cb-dest-title">Player Wallet</div>
                </div>
                <div
                  className={`cb-dest-card ${destination === 'agent_wallet' ? 'active' : ''}`}
                  onClick={() => setDestination('agent_wallet')}
                >
                  <div className="cb-dest-title">Agent Wallet</div>
                </div>
                <div
                  className={`cb-dest-card ${destination === 'promo_wallet' ? 'active' : ''}`}
                  onClick={() => setDestination('promo_wallet')}
                >
                  <div className="cb-dest-title">Promo Wallet</div>
                </div>
              </div>
            </div>
          )}

          <div className="cb-search-section">
            <input
              type="text"
              placeholder={`Search ${recipientType === 'member' ? 'members' : 'clubs'}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="cb-search-input"
            />
            <div className="cb-member-list">
              {recipientType === 'member'
                ? filteredMembers.map((m) => (
                    <div
                      key={m.user_id}
                      className={`cb-member-row ${recipientMember?.user_id === m.user_id ? 'selected' : ''}`}
                      onClick={() => setRecipientMember(m)}
                    >
                      <div className="cb-member-name">{m.name}</div>
                      <div className="cb-member-role">{m.role}</div>
                    </div>
                  ))
                : filteredClubs.map((c) => (
                    <div
                      key={c.id}
                      className={`cb-member-row ${recipientClub?.id === c.id ? 'selected' : ''}`}
                      onClick={() => setRecipientClub(c)}
                    >
                      <div className="cb-member-name">{c.name}</div>
                    </div>
                  ))}
            </div>
          </div>

          <div className="cb-form">
            <div className="cb-input-group">
              <label>Amount</label>
              <input
                type="number"
                min="0.01"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="cb-input-group">
              <label>Reason (Optional)</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Promo Distribution"
              />
            </div>
          </div>

          {error && <div className="cb-error">{error}</div>}

          <div className="cb-footer">
            <button className="cb-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="cb-btn-primary"
              onClick={onSend}
              disabled={
                sending ||
                !amount ||
                (recipientType === 'member' ? !recipientMember : !recipientClub)
              }
            >
              {sending ? 'Sending...' : 'Send Promo Chips'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
