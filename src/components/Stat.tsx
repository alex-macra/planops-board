import type { JSX, ReactNode } from "react";

export function StatRow({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="stat-row grid grid-cols-2 gap-px overflow-hidden border border-ui-border bg-ui-border sm:grid-cols-4">
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  emphasis = false,
  onClick,
}: {
  readonly label: string;
  readonly value: number;
  readonly sub: string;
  readonly emphasis?: boolean;
  readonly onClick?: (() => void) | undefined;
}): JSX.Element {
  const content = (
    <>
      <p className="text-xs text-ui-text-muted">{label}</p>
      <p className="tabular mt-0.5 text-[28px] font-medium leading-none tracking-tight text-ui-text">
        {value}
      </p>
      <p className="mt-1.5 truncate text-xs text-ui-text-subtle" title={sub}>
        {sub}
      </p>
    </>
  );

  const className = `stat min-w-0 bg-ui-bg-raised px-4 py-3 ${
    emphasis ? "stat-emphasis" : ""
  } ${onClick ? "stat-action" : ""}`;

  return onClick ? (
    <button
      type="button"
      className={`focus-ring text-left ${className}`}
      onClick={onClick}
      aria-label={`View ${value} ${label.toLowerCase()}`}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}
