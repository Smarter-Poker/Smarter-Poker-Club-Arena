import React from 'react';
import './TagGroup.css';

interface TagGroupProps {
  children: React.ReactNode;
  wrap?: boolean;
}

export const TagGroup: React.FC<TagGroupProps> = ({ children, wrap = true }) => {
  return <div className={`tag-group ${wrap ? 'wrap' : ''}`}>{children}</div>;
};

export default TagGroup;
