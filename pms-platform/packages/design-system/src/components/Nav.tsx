import type { ReactNode } from "react";

export type NavItem = {
  href: string;
  label: string;
  active?: boolean;
};

export type NavProps = {
  brand?: string;
  productName?: string;
  items: NavItem[];
  footer?: ReactNode;
  /** `sidebar` = host dashboard; `top` = guest / housekeeping */
  variant?: "sidebar" | "top";
};

export function Nav({
  brand = "PMS",
  productName = "Platform",
  items,
  footer,
  variant = "sidebar",
}: NavProps) {
  const top = variant === "top";
  return (
    <nav className={top ? "pms-nav pms-nav--top" : "pms-nav"} aria-label="Primary">
      <a className="pms-nav__brand" href="/">
        <span className="pms-nav__mark">
          {brand}
          <span>.</span>
        </span>
        <span className="pms-nav__sub">{productName}</span>
      </a>
      {items.map((item) => (
        <a
          key={item.href + item.label}
          href={item.href}
          className={`pms-nav__link${item.active ? " is-active" : ""}`}
        >
          {item.label}
        </a>
      ))}
      {footer && !top ? <div className="pms-nav__footer">{footer}</div> : null}
    </nav>
  );
}
