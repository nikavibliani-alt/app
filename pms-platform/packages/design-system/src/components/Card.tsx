import type { HTMLAttributes, ReactNode } from "react";

export type CardProps = HTMLAttributes<HTMLElement> & {
  title?: string;
  meta?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
};

export function Card({ title, meta, footer, children, className = "", ...rest }: CardProps) {
  return (
    <section className={`pms-card ${className}`.trim()} {...rest}>
      {(title || meta) && (
        <header className="pms-card__header">
          {title ? <h2 className="pms-card__title">{title}</h2> : <span />}
          {meta ? <div className="pms-card__meta">{meta}</div> : null}
        </header>
      )}
      {children ? <div className="pms-card__body">{children}</div> : null}
      {footer ? <footer className="pms-card__footer">{footer}</footer> : null}
    </section>
  );
}
