import React, { useState } from 'react';
import { AgentService } from '../../services';
import { useToast } from '../common/Toast';
import './ChipDistributionPanel.css';

interface DistributionTarget {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  currentBalance: number;
}

interface ChipDistributionPanelProps {
  sourceAgentId: string;
  sourceBalance: number;
  targets: DistributionTarget[];
  onDistribute?: () => void;
}

export const ChipDistributionPanel: React.FC<ChipDistributionPanelProps> = ({
  sourceAgentId,
  sourceBalance,
  targets,
  onDistribute,
}) => {
  const { showToast } = useToast();
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);

  const totalDistribution = Object.values(amounts).reduce((sum, amt) => sum + (amt || 0), 0);
  const remainingBalance = sourceBalance - totalDistribution;

  const handleAmountChange = (targetId: string, value: string) => {
    const num = parseInt(value) || 0;
    setAmounts((prev) => ({
      ...prev,
      [targetId]: Math.max(0, num),
    }));
  };

  const handleDistributeAll = async () => {
    if (totalDistribution <= 0) {
      showToast('Enter amounts to distribute', 'warning');
      return;
    }

    if (totalDistribution > sourceBalance) {
      showToast('Insufficient balance for distribution', 'error');
      return;
    }

    setLoading(true);
    try {
      const distributions = Object.entries(amounts)
        .filter(([_, amount]) => amount > 0)
        .map(([targetId, amount]) => ({
          toId: targetId,
          type: 'player' as const,
          amount,
        }));

      await AgentService.distributeChips(sourceAgentId, distributions);
      showToast(`Distributed ${totalDistribution.toLocaleString()} chips`, 'success');
      setAmounts({});
      onDistribute?.();
    } catch (error) {
      showToast('Distribution failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEqualSplit = () => {
    if (targets.length === 0) return;
    const perTarget = Math.trunc((sourceBalance / targets.length) * 100) / 100;
    const newAmounts: Record<string, number> = {};
    targets.forEach((t) => {
      newAmounts[t.id] = perTarget;
    });
    setAmounts(newAmounts);
  };

  return (
    <div className="chip-distribution-panel">
      <div className="distribution-header">
        <h3>Chip Distribution</h3>
        <div className="source-balance">
          <span className="balance-label">Available</span>
          <span className="balance-value">{sourceBalance.toLocaleString()}</span>
        </div>
      </div>

      <div className="distribution-actions">
        <button className="action-btn" onClick={handleEqualSplit}>
          Equal Split
        </button>
        <button className="action-btn clear" onClick={() => setAmounts({})}>
          ✕ Clear All
        </button>
      </div>

      <div className="targets-list">
        {targets.map((target, i) => (
          <div
            key={target.id}
            className="target-row"
            style={{
              opacity: i < 20 ? 1 : 0.8,
              transform: 'translateY(0)',
              transition: `all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) ${i * 60}ms`,
            }}
          >
            <div className="target-avatar">
              {target.avatarUrl ? (
                <img
                  loading="lazy"
                  decoding="async"
                  src={target.avatarUrl}
                  alt={target.displayName}
                />
              ) : (
                <span>{(target.displayName || '?')[0]}</span>
              )}
            </div>
            <div className="target-info">
              <div className="target-name">{target.displayName}</div>
              <div className="target-balance">
                Balance: {target.currentBalance.toLocaleString()}
              </div>
            </div>
            <div className="target-input">
              <input
                type="number"
                value={amounts[target.id] || ''}
                onChange={(e) => handleAmountChange(target.id, e.target.value)}
                placeholder="0"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="distribution-summary">
        <div className="summary-row">
          <span>Total to Distribute</span>
          <span className={totalDistribution > sourceBalance ? 'over-limit' : ''}>
            {totalDistribution.toLocaleString()}
          </span>
        </div>
        <div className="summary-row">
          <span>Remaining Balance</span>
          <span className={remainingBalance < 0 ? 'negative' : ''}>
            {remainingBalance.toLocaleString()}
          </span>
        </div>
      </div>

      <button
        className="distribute-btn"
        onClick={handleDistributeAll}
        disabled={loading || totalDistribution <= 0 || totalDistribution > sourceBalance}
      >
        {loading ? 'Distributing...' : `Distribute ${totalDistribution.toLocaleString()} Chips`}
      </button>
    </div>
  );
};

export default ChipDistributionPanel;
