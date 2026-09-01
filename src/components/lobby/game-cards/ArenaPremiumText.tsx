import type { CSSProperties, ElementType, ReactNode } from 'react';

type PremiumTextTone = 'silver' | 'blue' | 'green' | 'gold';

interface ArenaPremiumTextProps {
  as?: ElementType;
  children: ReactNode;
  className?: string;
  tone?: PremiumTextTone;
  style?: CSSProperties;
  title?: string;
}

export function ArenaPremiumValueText({
  as: Component = 'strong',
  children,
  className,
  tone = 'silver',
  style,
  title,
}: ArenaPremiumTextProps) {
  return (
    <Component
      className={`arena-premium-text arena-premium-text--value arena-premium-text--${tone}${className ? ` ${className}` : ''}`}
      style={style}
      title={title}
    >
      {children}
    </Component>
  );
}

export function ArenaPremiumTitle({
  as: Component = 'h3',
  children,
  className,
  style,
  title,
}: Omit<ArenaPremiumTextProps, 'tone'>) {
  return (
    <Component
      className={`arena-premium-text arena-premium-text--title${className ? ` ${className}` : ''}`}
      style={style}
      title={title}
    >
      {children}
    </Component>
  );
}
