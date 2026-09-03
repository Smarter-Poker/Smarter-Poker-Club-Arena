import React, { useState } from 'react';
import './Collapsible.css';

interface CollapsibleProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export const Collapsible: React.FC<CollapsibleProps> = ({
  title,
  children,
  defaultOpen = false,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`collapsible ${isOpen ? 'open' : ''}`}>
      <button className="collapsible-trigger" onClick={() => setIsOpen(!isOpen)}>
        <span>{title}</span>
        <span className="collapsible-arrow">›</span>
      </button>
      <div className="collapsible-content">{children}</div>
    </div>
  );
};

export default Collapsible;
