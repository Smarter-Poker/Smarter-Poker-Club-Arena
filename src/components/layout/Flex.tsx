import React from 'react';
import './Flex.css';

interface FlexProps {
  children: React.ReactNode;
  direction?: 'row' | 'column';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  align?: 'start' | 'center' | 'end' | 'stretch';
  gap?: number;
  wrap?: boolean;
}

export const Flex: React.FC<FlexProps> = ({
  children,
  direction = 'row',
  justify = 'start',
  align = 'stretch',
  gap = 0,
  wrap = false,
}) => {
  return (
    <div
      className={`flex dir-${direction} justify-${justify} align-${align} ${wrap ? 'wrap' : ''}`}
      style={{ gap }}
    >
      {children}
    </div>
  );
};

export default Flex;
