import type { CSSProperties, ElementType, ReactNode, Ref } from 'react';

type PremiumTextTone = 'silver' | 'blue' | 'green' | 'gold';

interface ArenaPremiumTextProps {
  as?: ElementType;
  children: ReactNode;
  className?: string;
  tone?: PremiumTextTone;
  style?: CSSProperties;
  title?: string;
  /** React 19: a plain prop. Used by useFitText to measure the rendered run. */
  ref?: Ref<HTMLElement>;
}

export function ArenaPremiumValueText({
  as: Component = 'strong',
  children,
  className,
  tone = 'silver',
  style,
  title,
  ref,
}: ArenaPremiumTextProps) {
  return (
    <Component
      ref={ref}
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
  ref,
}: Omit<ArenaPremiumTextProps, 'tone'>) {
  return (
    <Component
      ref={ref}
      className={`arena-premium-text arena-premium-text--title${className ? ` ${className}` : ''}`}
      style={style}
      title={title}
    >
      {children}
    </Component>
  );
}
