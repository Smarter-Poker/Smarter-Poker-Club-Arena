import React from 'react';
import './Highlight.css';

interface HighlightProps {
  children: string;
  query: string;
  highlightClass?: string;
}

export const Highlight: React.FC<HighlightProps> = ({
  children,
  query,
  highlightClass = 'highlighted',
}) => {
  if (!query.trim()) {
    return <span>{children}</span>;
  }

  const regex = new RegExp(`(${query})`, 'gi');
  const parts = children.split(regex);

  return (
    <span>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className={highlightClass}>
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </span>
  );
};

export default Highlight;
