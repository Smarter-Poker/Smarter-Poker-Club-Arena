import React from 'react';
import './Heading.css';

interface HeadingProps {
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  children: React.ReactNode;
  className?: string;
}

export const Heading: React.FC<HeadingProps> = ({ level = 2, children, className = '' }) => {
  const Tag = `h${level}` as React.ElementType;
  return <Tag className={`heading h${level} ${className}`}>{children}</Tag>;
};

export default Heading;
