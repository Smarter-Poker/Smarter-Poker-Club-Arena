import React from 'react';
import styles from './StandardContentLayout.module.css';

interface StandardContentLayoutProps {
  children: React.ReactNode;
  /**
   * Optional title for the page. If not provided, it assumes the page handles its own header.
   */
  title?: string;
  className?: string;
}

export default function StandardContentLayout({
  children,
  title,
  className = '',
}: StandardContentLayoutProps) {
  return (
    <div className={`${styles.pageContainer} ${className}`}>
      <div className={styles.contentColumn}>
        {title && <h1 className={styles.pageTitle}>{title}</h1>}
        <div className={styles.feedLayout}>{children}</div>
      </div>
    </div>
  );
}
