import React from 'react';
import './Truncate.css';

interface TruncateProps {
  children: string;
  lines?: number;
  expandable?: boolean;
}

export const Truncate: React.FC<TruncateProps> = ({ children, lines = 2, expandable = false }) => {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="truncate-wrapper">
      <p
        className={`truncate ${expanded ? 'expanded' : ''}`}
        style={{ WebkitLineClamp: expanded ? 'unset' : lines }}
      >
        {children}
      </p>
      {expandable && (
        <button className="truncate-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show Less' : 'Show More'}
        </button>
      )}
    </div>
  );
};

export default Truncate;
