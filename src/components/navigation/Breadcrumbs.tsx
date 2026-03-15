import React from 'react';
import './Breadcrumbs.css';

interface BreadcrumbItem {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  separator?: string;
}

export const Breadcrumbs: React.FC<BreadcrumbsProps> = ({ items, separator = '/' }) => {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((item, i) => (
          <li key={i}>
            {i < items.length - 1 ? (
              <>
                <a href={item.href || '#'} onClick={(e) => { if (item.onClick) { e.preventDefault(); item.onClick(); } }} className="breadcrumb-link">
                  {item.label}
                </a>
                <span className="separator">{separator}</span>
              </>
            ) : (
              <span className="breadcrumb-current">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
};

export default Breadcrumbs;
