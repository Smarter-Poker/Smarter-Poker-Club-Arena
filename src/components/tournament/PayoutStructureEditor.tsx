/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PAYOUT STRUCTURE EDITOR — UI for selecting and customizing payout structures
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { payoutEngine, type PayoutEntry, type PayoutTemplate } from '../../services/PayoutEngine';
import './PayoutStructureEditor.css';

interface PayoutStructureEditorProps {
  playerCount: number;
  prizePool: number;
  onChange: (payouts: PayoutEntry[]) => void;
  initialTemplate?: PayoutTemplate;
}

export const PayoutStructureEditor: React.FC<PayoutStructureEditorProps> = ({
  playerCount,
  prizePool,
  onChange,
  initialTemplate = 'top15',
}) => {
  const [template, setTemplate] = useState<PayoutTemplate>(initialTemplate);
  const [customPayouts, setCustomPayouts] = useState<PayoutEntry[]>([]);

  const templateOptions = payoutEngine.getTemplateOptions();

  // Generate payouts based on template + player count
  const payouts = useMemo(() => {
    const generated = payoutEngine.generatePayouts(
      template,
      playerCount,
      template === 'custom' ? customPayouts : undefined
    );
    return payoutEngine.calculateAmounts(generated, prizePool);
  }, [template, playerCount, prizePool, customPayouts]);

  // Update parent when payouts change
  useEffect(() => {
    onChange(payouts);
  }, [payouts]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTemplateChange = useCallback(
    (newTemplate: PayoutTemplate) => {
      setTemplate(newTemplate);
      if (newTemplate === 'custom') {
        // Seed custom with current payouts
        setCustomPayouts(payouts.map((p) => ({ place: p.place, percentage: p.percentage })));
      }
    },
    [payouts]
  );

  const updateCustomPayout = useCallback((index: number, percentage: number) => {
    setCustomPayouts((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], percentage };
      return updated;
    });
  }, []);

  const addCustomPlace = useCallback(() => {
    setCustomPayouts((prev) => [...prev, { place: prev.length + 1, percentage: 5 }]);
  }, []);

  const removeCustomPlace = useCallback((index: number) => {
    setCustomPayouts((prev) => {
      const updated = prev.filter((_, i) => i !== index);
      return updated.map((p, i) => ({ ...p, place: i + 1 }));
    });
  }, []);

  // Percentage total validation
  const totalPercent = payouts.reduce((s, p) => s + p.percentage, 0);
  const isValid = Math.abs(totalPercent - 100) < 0.5;

  // Visual bar chart max
  const maxPercent = Math.max(...payouts.map((p) => p.percentage), 1);

  return (
    <div className="payout-editor">
      {/* ── Template Selector ── */}
      <div className="pe-templates">
        {templateOptions.map((opt) => (
          <button
            type="button"
            key={opt.value}
            className={`pe-template-btn ${template === opt.value ? 'active' : ''}`}
            onClick={() => handleTemplateChange(opt.value)}
            title={opt.description}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* ── Summary ── */}
      <div className="pe-summary">
        <span className="pe-summary-item">
          <strong>{payouts.length}</strong> Paid Positions
        </span>
        <span className="pe-separator">•</span>
        <span className="pe-summary-item">
          Prize Pool: <strong>{prizePool.toLocaleString()}</strong>
        </span>
        <span className="pe-separator">•</span>
        <span className="pe-summary-item">
          ITM: <strong>{Math.round((payouts.length / Math.max(playerCount, 1)) * 100)}%</strong>
        </span>
      </div>

      {/* ── Payout Table ── */}
      <div className="pe-table">
        {payouts.map((p, i) => (
          <div key={p.place} className="pe-row">
            <div className="pe-place">
              {p.place <= 3 ? ['★', '☆', '✧'][p.place - 1] : `${p.place}th`}
            </div>
            <div className="pe-bar-wrapper">
              <div className="pe-bar" style={{ width: `${(p.percentage / maxPercent) * 100}%` }} />
              <span className="pe-bar-label">{p.percentage.toFixed(1)}%</span>
            </div>
            <div className="pe-amount">{p.amount?.toLocaleString() || '-'}</div>
            {template === 'custom' && (
              <div className="pe-custom-controls">
                <input
                  type="number"
                  className="pe-custom-input"
                  value={customPayouts[i]?.percentage || p.percentage}
                  onChange={(e) => updateCustomPayout(i, Number(e.target.value))}
                  min={0.5}
                  max={100}
                  step={0.5}
                />
                <button
                  type="button"
                  className="pe-remove-btn"
                  onClick={() => removeCustomPlace(i)}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Custom Add / Validation ── */}
      {template === 'custom' && (
        <div className="pe-custom-footer">
          <button type="button" className="pe-add-place" onClick={addCustomPlace}>
            + Add Place
          </button>
          <span className={`pe-total ${isValid ? 'pe-valid' : 'pe-invalid'}`}>
            Total: {totalPercent.toFixed(1)}%{!isValid && ' ⚠'}
          </span>
        </div>
      )}
    </div>
  );
};

export default PayoutStructureEditor;
