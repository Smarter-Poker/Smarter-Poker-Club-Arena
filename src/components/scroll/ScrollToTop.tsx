import React from 'react';
import './ScrollToTop.css';

interface ScrollToTopProps {
  visible: boolean;
  onClick: () => void;
}

export const ScrollToTop: React.FC<ScrollToTopProps> = ({ visible, onClick }) => {
  if (!visible) return null;

  return (
    <button className="scroll-to-top" onClick={onClick}>
      ↑
    </button>
  );
};

export default ScrollToTop;
