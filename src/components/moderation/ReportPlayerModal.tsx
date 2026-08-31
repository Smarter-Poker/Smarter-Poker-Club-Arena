import React, { useState, useEffect, useRef } from 'react';
import { useToast } from '../common/Toast';
import './ReportPlayerModal.css';

interface ReportPlayerModalProps {
  playerId: string;
  playerName: string;
  isOpen: boolean;
  onClose: () => void;
  onSubmit?: (report: ReportData) => Promise<void>;
}

interface ReportData {
  playerId: string;
  reason: string;
  details: string;
  handId?: string;
}

const REPORT_REASONS = [
  { id: 'collusion', label: 'Collusion', description: 'Playing Together To Cheat Others' },
  {
    id: 'chip_dumping',
    label: 'Chip Dumping',
    description: 'Intentionally Losing Chips To Another Player',
  },
  { id: 'harassment', label: 'Harassment', description: 'Offensive Or Abusive Behavior In Chat' },
  {
    id: 'slow_play',
    label: 'Intentional Slow Play',
    description: 'Deliberately Stalling To Annoy Others',
  },
  {
    id: 'software',
    label: 'Unauthorized Software',
    description: 'Using Automated Software To Play',
  },
  { id: 'other', label: 'Other', description: 'Other Violation Not Listed Above' },
];

export const ReportPlayerModal: React.FC<ReportPlayerModalProps> = ({
  playerId,
  playerName,
  isOpen,
  onClose,
  onSubmit,
}) => {
  const toast = useToast();
  const [selectedReason, setSelectedReason] = useState<string>('');
  const [details, setDetails] = useState('');
  const [handId, setHandId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const mountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isOpen) {
      if (mountTimerRef.current) clearTimeout(mountTimerRef.current);
      mountTimerRef.current = setTimeout(() => {
        mountTimerRef.current = null;
        setMounted(true);
      }, 50);
    } else {
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
      setMounted(false);
    }
    return () => {
      if (mountTimerRef.current) {
        clearTimeout(mountTimerRef.current);
        mountTimerRef.current = null;
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!selectedReason) {
      toast.warning('Please select a reason for the report');
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit?.({
        playerId,
        reason: selectedReason,
        details,
        handId: handId || undefined,
      });
      toast.success('Report submitted successfully');
      onClose();
    } catch (error) {
      toast.error('Failed to submit report');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="report-modal-overlay" onClick={onClose}>
      <div
        className="report-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <div className="report-header">
          <h2>Report Player</h2>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="report-player-info">
          <span className="reporting-label">Reporting:</span>
          <span className="player-name">{playerName}</span>
        </div>

        <div className="report-reasons">
          <h3>Reason For Report</h3>
          {REPORT_REASONS.map((reason) => (
            <label
              key={reason.id}
              className={`reason-option ${selectedReason === reason.id ? 'selected' : ''}`}
            >
              <input
                type="radio"
                name="reason"
                value={reason.id}
                checked={selectedReason === reason.id}
                onChange={() => setSelectedReason(reason.id)}
              />
              <div className="reason-content">
                <span className="reason-label">{reason.label}</span>
                <span className="reason-desc">{reason.description}</span>
              </div>
            </label>
          ))}
        </div>

        <div className="report-details">
          <label>
            <span>Additional Details (Optional)</span>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Provide Any Additional Context..."
              rows={3}
            />
          </label>
        </div>

        <div className="report-hand">
          <label>
            <span>Related Hand ID (Optional)</span>
            <input
              type="text"
              value={handId}
              onChange={(e) => setHandId(e.target.value)}
              placeholder="E.G., #12345678"
            />
          </label>
        </div>

        <div className="report-actions">
          <button className="cancel-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="submit-btn"
            onClick={handleSubmit}
            disabled={submitting || !selectedReason}
          >
            {submitting ? 'Submitting...' : 'Submit Report'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReportPlayerModal;
