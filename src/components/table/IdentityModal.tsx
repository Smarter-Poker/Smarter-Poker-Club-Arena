import React, { useState, useEffect } from 'react';
import './IdentityModal.css';

interface IdentityModalProps {
  isOpen: boolean;
  onClose: () => void;
  useAlias: boolean;
  tableAlias: string;
  onToggleAlias: () => void;
  onSetAlias: (alias: string) => void;
}

export function IdentityModal({
  isOpen,
  onClose,
  useAlias,
  tableAlias,
  onToggleAlias,
  onSetAlias,
}: IdentityModalProps) {
  const [aliasInput, setAliasInput] = useState(tableAlias);

  useEffect(() => {
    if (isOpen) {
      setAliasInput(tableAlias);
    }
  }, [isOpen, tableAlias]);

  if (!isOpen) return null;

  return (
    <div className="identity-modal-overlay" onClick={onClose}>
      <div className="identity-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="identity-modal-header">
          <h2>Identity Settings</h2>
          <button className="identity-modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="identity-modal-body">
          <div className="identity-modal-row">
            <label>Use Alias At Tables</label>
            <button
              className={`tsp-toggle ${useAlias ? 'tsp-toggle--on' : 'tsp-toggle--off'}`}
              onClick={onToggleAlias}
            >
              <span className="tsp-toggle__track">
                <span className="tsp-toggle__thumb" />
              </span>
            </button>
          </div>
          <div className="identity-modal-row">
            <label>Table Alias</label>
            <input
              type="text"
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              placeholder="Enter Your Alias"
              maxLength={20}
              className="identity-alias-input"
            />
          </div>
          <button
            className="identity-save-btn"
            onClick={() => {
              if (aliasInput !== tableAlias) onSetAlias(aliasInput);
              onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default IdentityModal;
