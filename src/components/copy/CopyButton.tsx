import React, { useState } from 'react';
import './CopyButton.css';

interface CopyButtonProps {
  text: string;
  label?: string;
  successMessage?: string;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  label = 'Copy',
  successMessage = 'Copied!',
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button className={`copy-button ${copied ? 'copied' : ''}`} onClick={handleCopy}>
      {copied ? <> {successMessage}</> : <> {label}</>}
    </button>
  );
};

export default CopyButton;
