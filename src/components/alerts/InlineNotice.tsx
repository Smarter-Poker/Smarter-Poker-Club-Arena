import React from 'react';
import './InlineNotice.css';

interface InlineNoticeProps {
  variant: 'tip' | 'note' | 'caution';
  children: React.ReactNode;
}

export const InlineNotice: React.FC<InlineNoticeProps> = ({ variant, children }) => {
  return <div className={`inline-notice variant-${variant}`}>{children}</div>;
};

export default InlineNotice;
