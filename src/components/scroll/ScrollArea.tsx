import React, { useRef, useState, useEffect } from 'react';
import './ScrollArea.css';

interface ScrollAreaProps {
  children: React.ReactNode;
  maxHeight?: number | string;
  onScrollEnd?: () => void;
}

export const ScrollArea: React.FC<ScrollAreaProps> = ({
  children,
  maxHeight = 400,
  onScrollEnd,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);
  const [showBottom, setShowBottom] = useState(false);

  const checkScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowTop(scrollTop > 10);
    setShowBottom(scrollTop < scrollHeight - clientHeight - 10);

    if (scrollTop + clientHeight >= scrollHeight - 5) {
      onScrollEnd?.();
    }
  };

  useEffect(() => {
    checkScroll();
  }, [children]);

  return (
    <div className="scroll-area-wrapper">
      {showTop && <div className="scroll-fade top" />}
      <div ref={scrollRef} className="scroll-area" style={{ maxHeight }} onScroll={checkScroll}>
        {children}
      </div>
      {showBottom && <div className="scroll-fade bottom" />}
    </div>
  );
};

export default ScrollArea;
