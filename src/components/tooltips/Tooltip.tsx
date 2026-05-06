import React, { useState, useRef, useEffect } from 'react';
import './Tooltip.css';

interface TooltipProps {
  children: React.ReactNode;
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
  children,
  content,
  position = 'top',
  delay = 200,
}) => {
  const [visible, setVisible] = useState(false);
  // CA-17 BUG FIX: was useState(timeoutId) — caused an extra re-render on every
  // hover AND had no unmount cleanup. Using useRef avoids the re-render and lets
  // us cancel the pending show-delay timer when the component unmounts.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const showTooltip = () => {
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      setVisible(true);
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  return (
    <div className="tooltip-wrapper" onMouseEnter={showTooltip} onMouseLeave={hideTooltip}>
      {children}
      {visible && <div className={`tooltip position-${position}`}>{content}</div>}
    </div>
  );
};

export default Tooltip;
