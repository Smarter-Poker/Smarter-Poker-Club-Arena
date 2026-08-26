/**
 *  CREDIT REQUEST WIDGET — Agent Credit Request UI
 */

import { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { creditRequestService, type CreditRequest } from '../../services/CreditRequestService';
import { useToast } from '../common/Toast';
import { masterBus } from '../../core/MasterBus';
import './CreditRequestWidget.css';
import { reportError } from '../../utils/errorReporter';

interface CreditRequestWidgetProps {
  agentId: string;
  agentName: string;
  parentAgentId?: string;
  currentCreditLimit: number;
  currentCreditUsed: number;
}

export default function CreditRequestWidget({
  agentId,
  agentName,
  parentAgentId,
  currentCreditLimit,
  currentCreditUsed,
}: CreditRequestWidgetProps) {
  const isMounted = useIsMounted();
  const toast = useToast();

  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [requests, setRequests] = useState<CreditRequest[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<CreditRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleApprovals, setVisibleApprovals] = useState<Set<number>>(new Set());
  const [visibleHistory, setVisibleHistory] = useState<Set<number>>(new Set());
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestAmount, setRequestAmount] = useState('');
  const [requestReason, setRequestReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadRequests();
  }, [agentId]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  // Bus listener: refresh when credit status changes elsewhere
  useEffect(() => {
    const unsub = masterBus.subscribeDebounced(
      'CREDIT_UPDATED',
      () => {
        if (isMounted.current) loadRequests();
      },
      500
    );
    return unsub;
  }, [agentId]);

  const loadRequests = async () => {
    setLoading(true);
    try {
      // Load my requests
      const myReqs = await creditRequestService.getMyRequests(agentId);
      if (!isMounted.current) return;
      setRequests(myReqs);

      // Load requests I need to approve (if I'm a super agent)
      const toApprove = await creditRequestService.getRequestsForApprover(agentId);
      if (!isMounted.current) return;
      const pending = toApprove.filter((r) => r.status === 'pending');
      setPendingApprovals(pending);
      setVisibleApprovals(new Set());
      staggerTimersRef.current.forEach(clearTimeout);
      staggerTimersRef.current = pending.map((_, i) =>
        setTimeout(() => setVisibleApprovals((prev) => new Set(prev).add(i)), i * 60)
      );
      setVisibleHistory(new Set());
      const histTimers = myReqs
        .slice(0, 5)
        .map((_, i) => setTimeout(() => setVisibleHistory((prev) => new Set(prev).add(i)), i * 60));
      staggerTimersRef.current.push(...histTimers);
    } catch (error) {
      reportError(error, 'CreditRequestWidget.Failed_to_load_credit_requests');
      if (isMounted.current) toast.error('Failed to load credit requests');
    }
    if (isMounted.current) setLoading(false);
  };

  const handleSubmitRequest = async () => {
    if (!parentAgentId) {
      toast.error('No parent agent to request credit from');
      return;
    }

    const amount = parseFloat(requestAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    setSubmitting(true);
    try {
      await creditRequestService.submitRequest(agentId, {
        approverId: parentAgentId,
        requestedAmount: amount,
        reason: requestReason || 'Credit limit increase',
      });
      if (isMounted.current) toast.success('Credit request submitted');
      setShowRequestForm(false);
      setRequestAmount('');
      setRequestReason('');
      loadRequests();
    } catch (error) {
      if (isMounted.current) toast.error('Failed to submit request');
    } finally {
      if (isMounted.current) setSubmitting(false);
    }
  };

  const handleApprove = async (request: CreditRequest) => {
    try {
      await creditRequestService.approveRequest(request.id, agentId);
      if (isMounted.current)
        toast.success(
          `Approved ${request.requestedAmount.toLocaleString()} for ${request.requesterName}`
        );
      masterBus.emit('CREDIT_UPDATED', { clubId: '', userId: request.requesterId });
      loadRequests();
    } catch (error) {
      if (isMounted.current) toast.error('Failed to approve request');
    }
  };

  const handleDeny = async (request: CreditRequest) => {
    try {
      await creditRequestService.denyRequest(request.id, agentId);
      if (isMounted.current) toast.success('Request denied');
      masterBus.emit('CREDIT_UPDATED', { clubId: '', userId: request.requesterId });
      loadRequests();
    } catch (error) {
      if (isMounted.current) toast.error('Failed to deny request');
    }
  };

  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      pending: '#f59e0b',
      approved: '#10b981',
      denied: '#ef4444',
      cancelled: '#6b7280',
    };
    return (
      <span className="status-badge" style={{ backgroundColor: colors[status] || '#6b7280' }}>
        {status}
      </span>
    );
  };

  if (loading) {
    return <div className="credit-request-widget loading">Loading...</div>;
  }

  return (
    <div className="credit-request-widget">
      {/* Current Credit Status */}
      <div className="credit-status">
        <div className="credit-bar">
          <div
            className="credit-used"
            style={{
              width: `${Math.min(100, (currentCreditUsed / (currentCreditLimit || 1)) * 100)}%`,
            }}
          />
        </div>
        <div className="credit-info">
          <span>{currentCreditUsed.toLocaleString()} Used</span>
          <span>Of {currentCreditLimit.toLocaleString()}</span>
        </div>
      </div>

      {/* Request Credit Button */}
      {parentAgentId && (
        <button className="request-btn" onClick={() => setShowRequestForm(!showRequestForm)}>
          {showRequestForm ? 'Cancel' : '+ Request Credit'}
        </button>
      )}

      {/* Request Form */}
      {showRequestForm && (
        <div className="request-form">
          <input
            type="number"
            placeholder="Amount"
            value={requestAmount}
            onChange={(e) => setRequestAmount(e.target.value)}
          />
          <textarea
            placeholder="Reason (Optional)"
            value={requestReason}
            onChange={(e) => setRequestReason(e.target.value)}
          />
          <button onClick={handleSubmitRequest} disabled={submitting}>
            {submitting ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      )}

      {/* Pending Approvals (for super agents) */}
      {pendingApprovals.length > 0 && (
        <div className="pending-approvals">
          <h4> Pending Approvals ({pendingApprovals.length})</h4>
          {pendingApprovals.map((req, i) => (
            <div
              key={req.id}
              className="approval-card"
              style={{
                opacity: visibleApprovals.has(i) ? 1 : 0,
                transform: visibleApprovals.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="approval-info">
                <span className="requester">{req.requesterName}</span>
                <span className="amount">
                  {req.requestedAmount.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
                <span className="reason">{req.reason}</span>
              </div>
              <div className="approval-actions">
                <button className="approve-btn" onClick={() => handleApprove(req)}>
                  ✓
                </button>
                <button className="deny-btn" onClick={() => handleDeny(req)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* My Request History */}
      {requests.length > 0 && (
        <div className="request-history">
          <h4>My Requests</h4>
          {requests.slice(0, 5).map((req, i) => (
            <div
              key={req.id}
              className="request-row"
              style={{
                opacity: visibleHistory.has(i) ? 1 : 0,
                transform: visibleHistory.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <span className="request-amount">
                {req.requestedAmount.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
              {getStatusBadge(req.status)}
              <span className="request-date">{new Date(req.createdAt).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
