import React, { useState } from 'react';
import './Accordion.css';

interface AccordionItem {
  id: string;
  title: string;
  content: React.ReactNode;
}

interface AccordionProps {
  items: AccordionItem[];
  allowMultiple?: boolean;
}

export const Accordion: React.FC<AccordionProps> = ({ items, allowMultiple = false }) => {
  const [openIds, setOpenIds] = useState<string[]>([]);

  const toggle = (id: string) => {
    if (allowMultiple) {
      setOpenIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
    } else {
      setOpenIds((prev) => (prev.includes(id) ? [] : [id]));
    }
  };

  return (
    <div className="accordion">
      {items.map((item) => (
        <div key={item.id} className={`accordion-item ${openIds.includes(item.id) ? 'open' : ''}`}>
          <button className="accordion-header" onClick={() => toggle(item.id)}>
            <span>{item.title}</span>
            <span className="accordion-icon">▼</span>
          </button>
          <div className="accordion-content">
            <div className="accordion-body">{item.content}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default Accordion;
