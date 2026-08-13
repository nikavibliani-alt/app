import type { InputHTMLAttributes, ReactNode } from "react";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: ReactNode;
  invalid?: boolean;
};

export function Input({ label, hint, invalid, id, className = "", ...rest }: InputProps) {
  return (
    <label className="pms-field" htmlFor={id}>
      {label ? <span className="pms-label">{label}</span> : null}
      <input
        id={id}
        className={`pms-input${invalid ? " pms-input--invalid" : ""} ${className}`.trim()}
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {hint ? <span className="pms-hint">{hint}</span> : null}
    </label>
  );
}
