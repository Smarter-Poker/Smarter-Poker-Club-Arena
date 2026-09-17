/** Credit requests are scoped to an authenticated account and one club. */
import { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useAuthUser } from '../../hooks/useAuthUser';
import { creditRequestService, type CreditRequest } from '../../services/CreditRequestService';
import { useToast } from '../common/Toast';
import { masterBus } from '../../core/MasterBus';
import { readCreditMoney, creditAdminMoney } from '../../utils/creditAdminData';
import { reportError } from '../../utils/errorReporter';
import { supabase } from '../../lib/supabase';
import { QUERY_LIMITS } from '../../lib/constants';
import './CreditRequestWidget.css';

interface CreditRequestWidgetProps {
  userId: string;
  clubId: string;
  approverUserId?: string;
  canRequest: boolean;
  /** Presentation only: the server rechecks current club-manager authority. */
  canReview: boolean;
  currentCreditLimit?: number;
  currentCreditUsed?: number;
  showCreditStatus?: boolean;
}

/** The same request reader and decision writer, available to managers without an agents row. */
export function CreditRequestManagerInbox({ clubId }: { clubId: string }) {
  const { user, isHydrating } = useAuthUser();
  if (isHydrating || !user?.id || !clubId) return null;
  return <CreditManagerInboxForScope key={JSON.stringify([user.id, clubId])}
    userId={user.id} clubId={clubId} />;
}

function CreditManagerInboxForScope({ userId, clubId }: { userId: string; clubId: string }) {
  const [authority, setAuthority] = useState<'loading' | 'allowed' | 'denied' | 'error'>('loading');
  useEffect(() => {
    let cancelled = false;
    async function loadAuthority() {
      try {
        const [club, membership] = await Promise.all([
          supabase.from('clubs').select('owner_id').eq('id', clubId).maybeSingle(),
          supabase.from('club_members').select('role, status')
            .eq('club_id', clubId).eq('user_id', userId).maybeSingle(),
        ]);
        if (cancelled) return;
        if (club.error) throw club.error;
        if (membership.error) throw membership.error;
        if (!club.data) throw new Error('Club owner could not be read.');
        setAuthority(club.data.owner_id === userId || (
          ['owner', 'co_owner', 'admin'].includes(membership.data?.role || '') &&
          ['active', 'approved'].includes(membership.data?.status || '')
        ) ? 'allowed' : 'denied');
      } catch (error) {
        if (!cancelled) setAuthority('error');
      }
    }
    void loadAuthority();
    return () => { cancelled = true; };
  }, [userId, clubId]);
  if (authority === 'loading') return <p>Checking credit request access...</p>;
  if (authority === 'error') return <p>Credit request access could not be verified.</p>;
  if (authority !== 'allowed') return null;
  return <section aria-label="Credit requests"><h2>Credit Requests</h2>
    <CreditRequestWidget userId={userId} clubId={clubId} canRequest={false} canReview
      showCreditStatus={false} />
  </section>;
}

export default function CreditRequestWidget(props: CreditRequestWidgetProps) {
  const { user, isHydrating } = useAuthUser();
  if (isHydrating || !user?.id || user.id !== props.userId || !props.clubId) {
    return <p>Credit requests are unavailable while your account is being verified.</p>;
  }
  const owner = JSON.stringify([user.id, props.clubId, props.approverUserId,
    props.canRequest, props.canReview]);
  return <CreditRequestsForScope key={owner} {...props} />;
}

function CreditRequestsForScope({ userId, clubId, approverUserId, canRequest, canReview,
  currentCreditLimit, currentCreditUsed, showCreditStatus = true }: CreditRequestWidgetProps) {
  const isMounted = useIsMounted();
  const toast = useToast();
  const loadGeneration = useRef(0);
  const actionInFlight = useRef(false);
  const [requests, setRequests] = useState<CreditRequest[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<CreditRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestAmount, setRequestAmount] = useState('');
  const [requestReason, setRequestReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadRequests();
    return () => { loadGeneration.current += 1; };
  }, []);
  useEffect(() => masterBus.subscribeDebounced('CREDIT_UPDATED', event => {
    if (event.payload.clubId === clubId && isMounted.current) void loadRequests();
  }, 500), [clubId]);

  async function loadRequests() {
    if (!isMounted.current) return;
    const generation = ++loadGeneration.current;
    const current = () => isMounted.current && generation === loadGeneration.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [mine, routed] = await Promise.all([
        creditRequestService.getMyRequests(userId, clubId),
        canReview
          ? creditRequestService.getPendingForClub(clubId, userId)
          : creditRequestService.getRequestsForApprover(userId, clubId),
      ]);
      if (!current()) return;
      // A scoped reader must not silently turn another club's record into ours.
      if (mine.some(r => r.clubId !== clubId || r.requesterId !== userId) ||
        routed.some(r => r.clubId !== clubId || (canReview
          ? r.status !== 'pending' : r.approverId !== userId))) {
        throw new Error('Credit request account or club did not match this view.');
      }
      setRequests(mine);
      setPendingApprovals(routed.filter(r => r.status === 'pending'));
    } catch (error) {
      if (!current()) return;
      reportError(error, 'CreditRequestWidget.load');
      setRequests([]);
      setPendingApprovals([]);
      setShowRequestForm(false);
      setLoadFailed(true);
    } finally {
      if (current()) setLoading(false);
    }
  }

  async function handleSubmitRequest() {
    if (actionInFlight.current || !isMounted.current || !canRequest || !approverUserId) return;
    const amount = readCreditMoney(requestAmount);
    if (amount === null || amount <= 0) {
      toast.error('Enter a positive credit limit with at most two decimal places.');
      return;
    }
    actionInFlight.current = true;
    setBusy(true);
    try {
      const receipt = await creditRequestService.submitRequest(userId, {
        approverId: approverUserId, clubId, requestedAmount: amount,
        reason: requestReason.trim() || 'Credit limit request',
      });
      if (!isMounted.current) return;
      if (receipt.clubId !== clubId || receipt.requesterId !== userId ||
        receipt.approverId !== approverUserId || receipt.status !== 'pending' ||
        receipt.requestedAmount !== amount) throw new Error('Credit request was not confirmed.');
      toast.success('Credit request submitted');
      setShowRequestForm(false);
      setRequestAmount('');
      setRequestReason('');
      await loadRequests();
    } catch (error) {
      if (isMounted.current) toast.error('Unable to confirm the request. Refresh its status before trying again.');
    } finally {
      actionInFlight.current = false;
      if (isMounted.current) setBusy(false);
    }
  }

  async function handleReview(request: CreditRequest, decision: 'approved' | 'denied') {
    if (actionInFlight.current || !isMounted.current || !canReview || request.clubId !== clubId ||
      request.status !== 'pending') return;
    actionInFlight.current = true;
    setBusy(true);
    try {
      const receipt = decision === 'approved'
        ? await creditRequestService.approveRequest(request.id, userId)
        : await creditRequestService.denyRequest(request.id, userId);
      if (!isMounted.current) return;
      if (receipt.id !== request.id || receipt.clubId !== clubId ||
        receipt.requesterId !== request.requesterId || receipt.status !== decision) {
        throw new Error('Credit request decision was not confirmed.');
      }
      toast.success(decision === 'approved'
        ? `Credit limit updated to ${creditAdminMoney(readCreditMoney(receipt.approvedAmount))}`
        : 'Request denied');
      // The service emits the single club-scoped event after the durable receipt.
      await loadRequests();
    } catch (error) {
      if (isMounted.current) toast.error('Unable to confirm the decision. Refresh its status before trying again.');
    } finally {
      actionInFlight.current = false;
      if (isMounted.current) setBusy(false);
    }
  }

  if (loading) return <div className="credit-request-widget loading">Loading credit requests...</div>;
  if (loadFailed) return <div className="credit-request-widget" role="alert">
    <p>Credit requests could not be loaded.</p>
    <button onClick={() => void loadRequests()}>Retry</button>
  </div>;

  const limit = readCreditMoney(currentCreditLimit);
  const used = readCreditMoney(currentCreditUsed);
  return <div className="credit-request-widget">
    {showCreditStatus && <div className="credit-status">
      {limit !== null && used !== null && <div className="credit-bar"><div className="credit-used"
        style={{ width: `${Math.min(100, (used / (limit || 1)) * 100)}%` }} /></div>}
      <div className="credit-info">
        <span>{creditAdminMoney(used)} Used</span><span>Of {creditAdminMoney(limit)}</span>
      </div>
    </div>}
    {canRequest && approverUserId && <button className="request-btn" disabled={busy}
      onClick={() => setShowRequestForm(!showRequestForm)}>
      {showRequestForm ? 'Cancel' : '+ Request Credit'}
    </button>}
    {canRequest && !approverUserId && <p>A credit request recipient could not be verified for this club.</p>}
    {showRequestForm && <div className="request-form">
      <label>New credit limit<input type="number" min="0.01" step="0.01" placeholder="New credit limit"
        value={requestAmount} disabled={busy} onChange={e => setRequestAmount(e.target.value)} /></label>
      <textarea aria-label="Reason (Optional)" placeholder="Reason (Optional)" value={requestReason}
        disabled={busy} onChange={e => setRequestReason(e.target.value)} />
      <button onClick={() => void handleSubmitRequest()} disabled={busy}>
        {busy ? 'Submitting...' : 'Submit Request'}
      </button>
    </div>}
    {pendingApprovals.length > 0 && <div className="pending-approvals">
      <h4>Pending Credit Requests Shown ({pendingApprovals.length})</h4>
      <p>Showing up to {QUERY_LIMITS.LIST} requests.</p>
      {!canReview && <p>Credit decisions require a club owner or administrator.</p>}
      {pendingApprovals.map(req => <div key={req.id} className="approval-card">
        <div className="approval-info">
          <span className="requester">{req.requesterName}</span>
          <span className="amount">{creditAdminMoney(readCreditMoney(req.requestedAmount))}</span>
          <span className="reason">{req.reason}</span>
        </div>
        {canReview && <div className="approval-actions">
          <button className="approve-btn" disabled={busy} aria-label={`Approve ${req.requesterName}`}
            onClick={() => void handleReview(req, 'approved')}>✓</button>
          <button className="deny-btn" disabled={busy} aria-label={`Deny ${req.requesterName}`}
            onClick={() => void handleReview(req, 'denied')}>✕</button>
        </div>}
      </div>)}
    </div>}
    {canReview && pendingApprovals.length === 0 && <p>No pending credit requests are visible for this club.</p>}
    {requests.length > 0 && <div className="request-history">
      <h4>My Recent Requests</h4>
      {requests.slice(0, 5).map(req => <div key={req.id} className="request-row">
        <span className="request-amount">{creditAdminMoney(readCreditMoney(req.requestedAmount))}</span>
        <span className="status-badge">{req.status}</span>
        <span className="request-date">{new Date(req.createdAt).toLocaleDateString()}</span>
      </div>)}
    </div>}
  </div>;
}
