import React, { useState } from 'react';
import './CopyField.css';

interface CopyFieldProps {
  value: string;
  label?: string;
}

export const CopyField: React.FC<CopyFieldProps> = ({ value, label }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="copy-field">
      {label && <label className="copy-label">{label}</label>}
      <div className="copy-input-wrapper">
        <input type="text" value={value} readOnly className="copy-input" />
        <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy}>
          {copied ? '' : ''}
        </button>
      </div>
    </div>
  );
};

export default CopyField;
