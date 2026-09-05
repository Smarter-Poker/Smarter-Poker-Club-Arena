import React from 'react';
import './Timeline.css';

interface TimelineItem {
  id: string;
  title: string;
  description?: string;
  time: string;
  icon?: React.ReactNode;
}

interface TimelineProps {
  items: TimelineItem[];
  variant?: 'default' | 'compact';
}

export const Timeline: React.FC<TimelineProps> = ({ items, variant = 'default' }) => {
  return (
    <div className={`timeline variant-${variant}`}>
      {items.map((item, idx) => (
        <div key={item.id} className="timeline-item">
          <div className="timeline__timeline-marker">
            {item.icon || <span className="marker-dot" />}
          </div>
          <div className="timeline-content">
            <div className="timeline-time">{item.time}</div>
            <div className="timeline-title">{item.title}</div>
            {item.description && <div className="timeline-desc">{item.description}</div>}
          </div>
          {idx < items.length - 1 && <div className="timeline-line" />}
        </div>
      ))}
    </div>
  );
};

export default Timeline;
