import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Info,
  Moon,
  Search,
  Sun,
  X,
} from "lucide-react";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

function classes(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

export type SpinnerSize = "xs" | "sm" | "md" | "lg";

const spinnerSizes: Record<SpinnerSize, string> = {
  xs: "h-3 w-3",
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

export function Spinner({ size = "md", className }: { readonly size?: SpinnerSize; readonly className?: string }): JSX.Element {
  return (
    <svg
      className={classes("animate-spin text-current", spinnerSizes[size], className)}
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-ui-accent text-ui-accent-fg hover:bg-ui-accent-hover",
  secondary: "border border-ui-border bg-ui-bg-muted text-ui-text hover:bg-ui-bg-subtle",
  ghost: "text-ui-text-muted hover:bg-ui-bg-muted hover:text-ui-text",
  danger: "bg-ui-danger text-ui-danger-fg hover:bg-ui-danger-hover",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 rounded-lg px-3 text-xs",
  md: "h-9 gap-2 rounded-xl px-4 text-sm",
  lg: "h-11 gap-2 rounded-xl px-5 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, icon, children, className, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={props.type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes(
        "focus-ring inline-flex items-center justify-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner size="sm" className="shrink-0" /> : icon ? <span className="shrink-0">{icon}</span> : null}
      {children}
    </button>
  );
});

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { error = false, className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={error || undefined}
      className={classes(
        "focus-ring w-full rounded-xl border bg-ui-bg-raised px-3 py-2 text-sm text-ui-text transition-colors placeholder:text-ui-text-subtle disabled:cursor-not-allowed disabled:opacity-50",
        error ? "border-ui-danger" : "border-ui-border hover:border-ui-text-subtle",
        className,
      )}
      {...props}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly error?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { error = false, className, ...props },
  ref,
) {
  return (
    <div className="relative w-full">
      <select
        ref={ref}
        aria-invalid={error || undefined}
        className={classes(
          "focus-ring w-full appearance-none rounded-xl border bg-ui-bg-raised px-3 py-2 pr-9 text-sm text-ui-text transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          error ? "border-ui-danger" : "border-ui-border hover:border-ui-text-subtle",
          className,
        )}
        {...props}
      />
      <ChevronDown
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ui-text-subtle"
      />
    </div>
  );
});

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  readonly required?: boolean;
}

export function Label({ required = false, children, className, ...props }: LabelProps): JSX.Element {
  return (
    <label className={classes("block text-sm font-medium text-ui-text", className)} {...props}>
      {children}
      {required ? <span className="ml-1 text-ui-danger" aria-hidden="true">*</span> : null}
    </label>
  );
}

export function KV({ k, v }: { readonly k: string; readonly v: ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-ui-border/70 bg-ui-bg/70 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ui-text-subtle">{k}</div>
      <div className="mt-1 break-words text-sm font-medium text-ui-text">{v}</div>
    </div>
  );
}

export interface SkeletonProps {
  readonly variant?: "text" | "rect" | "circle";
  readonly width?: string | number;
  readonly height?: string | number;
  readonly className?: string;
  readonly lines?: number;
}

export function Skeleton({ variant = "rect", width, height, className, lines = 1 }: SkeletonProps): JSX.Element {
  const style = {
    width: typeof width === "number" ? `${width}px` : width,
    height: typeof height === "number" ? `${height}px` : height,
  };
  const base = "animate-pulse bg-ui-bg-subtle";
  if (variant === "circle") {
    return <span className={classes(base, "block rounded-full", className)} style={style} aria-hidden="true" />;
  }
  if (variant === "text") {
    return (
      <div className={classes("space-y-2", className)} aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => (
          <span key={index} className={classes(base, "block h-4 rounded-md", index === lines - 1 && lines > 1 && "w-3/4")} />
        ))}
      </div>
    );
  }
  return <span className={classes(base, "block rounded-xl", className)} style={style} aria-hidden="true" />;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (candidate) => !candidate.hidden && candidate.getAttribute("aria-hidden") !== "true",
  );
}

function useDialogFocus(
  open: boolean,
  panelRef: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
  dismissible: boolean,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      (focusableWithin(panel)[0] ?? panel).focus();
    });
    const onKeyDown = (event: KeyboardEvent): void => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => previous?.focus());
    };
  }, [dismissible, open, panelRef]);
}

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly size?: "sm" | "md" | "lg" | "xl";
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly showHeader?: boolean;
  readonly dismissible?: boolean;
  readonly bodyClassName?: string;
}

const modalSizes: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

export function Modal({
  open,
  onClose,
  title,
  ariaLabel,
  size = "md",
  children,
  footer,
  className,
  showHeader = true,
  dismissible = true,
  bodyClassName = "px-6 py-4",
}: ModalProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(open, panelRef, onClose, dismissible);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[400] flex items-center justify-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close dialog"
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-sm"
        onClick={dismissible ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title && showHeader ? titleId : undefined}
        aria-label={!title || !showHeader ? ariaLabel ?? title : undefined}
        tabIndex={-1}
        className={classes(
          "relative z-10 w-full rounded-2xl border border-ui-border bg-ui-bg-raised shadow-xl focus:outline-none",
          modalSizes[size],
          className,
        )}
      >
        {showHeader ? (
          <div className="flex items-center justify-between border-b border-ui-border/60 px-6 py-4">
            {title ? <h2 id={titleId} className="text-base font-semibold text-ui-text">{title}</h2> : null}
            <button type="button" onClick={onClose} aria-label="Close" className="focus-ring ml-auto rounded-lg p-1 text-ui-text-subtle transition-colors hover:text-ui-text">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className={bodyClassName}>{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-ui-border/60 px-6 py-4">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly side?: "left" | "right";
  readonly size?: "sm" | "md" | "lg" | "xl";
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly showHeader?: boolean;
  readonly dismissible?: boolean;
  readonly bodyClassName?: string;
}

const drawerSizes: Record<NonNullable<DrawerProps["size"]>, string> = {
  sm: "w-72",
  md: "w-80",
  lg: "w-96",
  xl: "w-[28rem]",
};

export function Drawer({
  open,
  onClose,
  side = "right",
  size = "md",
  title,
  ariaLabel,
  children,
  footer,
  className,
  showHeader = true,
  dismissible = true,
  bodyClassName = "flex-1 overflow-y-auto px-4 py-3",
}: DrawerProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(open, panelRef, onClose, dismissible);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close drawer"
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-sm"
        onClick={dismissible ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title && showHeader ? titleId : undefined}
        aria-label={!title || !showHeader ? ariaLabel ?? title : undefined}
        tabIndex={-1}
        className={classes(
          "absolute bottom-0 top-0 z-10 flex max-w-full flex-col border-ui-border bg-ui-bg-raised shadow-xl focus:outline-none",
          side === "left" ? "left-0 border-r" : "right-0 border-l",
          drawerSizes[size],
          className,
        )}
      >
        {showHeader ? (
          <div className="flex shrink-0 items-center justify-between border-b border-ui-border/60 px-4 py-3">
            {title ? <h2 id={titleId} className="text-sm font-semibold text-ui-text">{title}</h2> : null}
            <button type="button" onClick={onClose} aria-label="Close" className="focus-ring ml-auto rounded-lg p-1 text-ui-text-subtle transition-colors hover:text-ui-text">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className={bodyClassName}>{children}</div>
        {footer ? <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ui-border/60 px-4 py-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly variant?: "default" | "destructive";
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "destructive",
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  return (
    <Modal open={open} onClose={onCancel} size="sm" showHeader={false} ariaLabel={title} className="max-w-xs">
      <div className="flex items-start gap-3">
        <div className={classes(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          variant === "destructive" ? "bg-ui-danger-bg text-ui-danger" : "bg-ui-bg-muted text-ui-accent",
        )}>
          <AlertTriangle size={14} aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-medium text-ui-text">{title}</p>
          {description ? <div className="mt-0.5 text-xs text-ui-text-subtle">{description}</div> : null}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={variant === "destructive" ? "danger" : "primary"} size="sm" onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}

export interface DropdownItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}

export interface DropdownGroup {
  readonly label?: string;
  readonly items: readonly DropdownItem[];
}

export interface DropdownMenuProps {
  readonly trigger: ReactNode;
  readonly groups: readonly DropdownGroup[];
  readonly side?: "bottom" | "top";
  readonly align?: "start" | "end";
  readonly className?: string;
}

export function DropdownMenu({ trigger, groups, side = "bottom", align = "start", className }: DropdownMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    const triggerElement = triggerRef.current;
    if (!triggerElement) return;
    const bounds = triggerElement.getBoundingClientRect();
    setPosition({
      top: side === "bottom" ? bounds.bottom + 4 : bounds.top - 4,
      left: align === "start" ? bounds.left : bounds.right,
    });
  }, [align, side]);

  const openMenu = useCallback((focus: "first" | "last" = "first") => {
    updatePosition();
    setOpen(true);
    window.requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])");
      (focus === "last" ? items?.item((items?.length ?? 1) - 1) : items?.item(0))?.focus();
    });
  }, [updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onReposition = (): void => updatePosition();
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open, updatePosition]);

  const menuItems = (): HTMLElement[] =>
    menuRef.current ? [...menuRef.current.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])")] : [];

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = menuItems();
    const current = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(current + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(current - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    } else if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        className="focus-ring inline-flex cursor-pointer rounded-lg"
        onClick={() => {
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowUp" ? "last" : "first");
          }
        }}
      >
        {trigger}
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ top: position.top, left: position.left }}
          className={classes(
            "fixed z-[150] min-w-[160px] rounded-xl border border-ui-border bg-ui-bg-raised py-1 shadow-xl",
            side === "top" && "-translate-y-full",
            align === "end" && "-translate-x-full",
            className,
          )}
          onKeyDown={onMenuKeyDown}
        >
          {groups.map((group, groupIndex) => (
            <div key={group.label ?? groupIndex} role="group" aria-label={group.label}>
              {groupIndex > 0 ? <div className="my-1 h-px bg-ui-border/60" aria-hidden="true" /> : null}
              {group.label ? <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ui-text-subtle" aria-hidden="true">{group.label}</div> : null}
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={classes(
                    "flex w-full items-center gap-2 px-3 py-2 text-sm",
                    item.disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-ui-bg-muted focus:bg-ui-bg-muted focus:outline-none",
                    item.danger && !item.disabled ? "text-ui-danger" : "text-ui-text",
                  )}
                  onClick={() => {
                    if (item.disabled) return;
                    item.onClick?.();
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  {item.icon ? <span className="flex size-4 shrink-0 items-center" aria-hidden="true">{item.icon}</span> : null}
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps): JSX.Element {
  return (
    <div className={classes("flex flex-col items-center justify-center gap-3 py-16 text-center", className)}>
      {icon ? <div className="mb-1 text-ui-text-subtle opacity-40" aria-hidden="true">{icon}</div> : null}
      <div>
        <p className="text-sm font-semibold text-ui-text">{title}</p>
        {description ? <p className="mx-auto mt-1 max-w-xs text-sm text-ui-text-muted">{description}</p> : null}
      </div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export interface SegmentedControlOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly ariaLabel?: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
}

export interface SegmentedControlProps {
  readonly options: readonly SegmentedControlOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel?: string;
  readonly size?: "sm" | "md";
  readonly fullWidth?: boolean;
  readonly className?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel = "Options",
  size = "md",
  fullWidth = false,
  className,
}: SegmentedControlProps): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled);
  const move = (index: number, direction: -1 | 1 | "first" | "last"): void => {
    const enabled = options.flatMap((option, optionIndex) => option.disabled ? [] : [optionIndex]);
    if (enabled.length === 0) return;
    const position = enabled.indexOf(index);
    const nextIndex = direction === "first"
      ? enabled[0]!
      : direction === "last"
        ? enabled.at(-1)!
        : enabled[(position + direction + enabled.length) % enabled.length]!;
    const next = options[nextIndex];
    if (!next) return;
    onChange(next.value);
    refs.current[nextIndex]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={classes("inline-grid grid-flow-col auto-cols-fr gap-1 rounded-lg border border-ui-border/60 bg-ui-bg-muted p-1", fullWidth && "w-full", className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            disabled={option.disabled}
            tabIndex={index === activeIndex ? 0 : -1}
            className={classes(
              "focus-ring inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50",
              size === "sm" ? "min-h-7 px-2.5 py-1 text-xs" : "min-h-9 px-3 py-1.5 text-sm",
              checked ? "bg-ui-bg-raised text-ui-text shadow-sm" : "text-ui-text-muted hover:bg-ui-bg-raised/60 hover:text-ui-text",
            )}
            onClick={() => { if (!option.disabled) onChange(option.value); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); move(index, 1); }
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); move(index, -1); }
              else if (event.key === "Home") { event.preventDefault(); move(index, "first"); }
              else if (event.key === "End") { event.preventDefault(); move(index, "last"); }
            }}
          >
            {option.icon ? <span className="shrink-0" aria-hidden="true">{option.icon}</span> : null}
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface FilterSelectOption { readonly value: string; readonly label: string }
export interface FilterSelect {
  readonly id: string;
  readonly label: string;
  readonly options: readonly FilterSelectOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}
export interface FilterBarProps {
  readonly search?: { readonly value: string; readonly onChange: (value: string) => void; readonly placeholder?: string };
  readonly filters?: readonly FilterSelect[];
  readonly onClear?: () => void;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function FilterBar({ search, filters = [], onClear, className, children }: FilterBarProps): JSX.Element {
  return (
    <div className={classes("flex flex-wrap items-center gap-2", className)}>
      {search ? (
        <div className="relative">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ui-text-subtle" />
          <input
            type="search"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder ?? "Search"}
            aria-label={search.placeholder ?? "Search"}
            className="focus-ring h-8 rounded-lg border border-ui-border bg-ui-bg-raised pl-8 pr-3 text-sm text-ui-text placeholder:text-ui-text-subtle"
          />
        </div>
      ) : null}
      {filters.map((filter) => (
        <div key={filter.id} className="relative">
          <select
            value={filter.value}
            onChange={(event) => filter.onChange(event.target.value)}
            aria-label={filter.label}
            className="focus-ring h-8 cursor-pointer appearance-none rounded-lg border border-ui-border bg-ui-bg-raised pl-3 pr-7 text-sm text-ui-text"
          >
            <option value="">{filter.label}: All</option>
            {filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <ChevronDown size={13} aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ui-text-subtle" />
        </div>
      ))}
      {onClear ? (
        <button type="button" onClick={onClear} aria-label="Clear all filters" className="focus-ring flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm text-ui-text-muted transition-colors hover:bg-ui-bg-muted hover:text-ui-text">
          <X size={12} aria-hidden="true" /> Clear
        </button>
      ) : null}
      {children}
    </div>
  );
}

export interface Column<T> {
  readonly key: keyof T & string;
  readonly header: string;
  readonly render?: (value: T[keyof T], row: T) => ReactNode;
  readonly sortable?: boolean;
  readonly width?: string;
  readonly align?: "left" | "center" | "right";
}

export interface DataTableProps<T extends { readonly id: string | number }> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly pageSize?: number;
  readonly emptyMessage?: string;
  readonly loading?: boolean;
  readonly className?: string;
}

function comparable(value: unknown): string | number {
  return typeof value === "number" ? value : String(value ?? "").toLocaleLowerCase();
}

export function DataTable<T extends { readonly id: string | number }>({
  columns,
  rows,
  pageSize = 10,
  emptyMessage = "No results",
  loading = false,
  className,
}: DataTableProps<T>): JSX.Element {
  const [sortKey, setSortKey] = useState<keyof T & string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const sorted = sortKey
    ? [...rows].sort((left, right) => {
        const a = comparable(left[sortKey]);
        const b = comparable(right[sortKey]);
        const result = a === b ? 0 : a < b ? -1 : 1;
        return sortDirection === "asc" ? result : -result;
      })
    : [...rows];
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const visible = sorted.slice(start, start + pageSize);
  return (
    <div className={classes("overflow-hidden rounded-xl border border-ui-border", className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-ui-border bg-ui-bg-muted">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={classes("px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-ui-text-subtle", column.width, column.align === "center" && "text-center", column.align === "right" && "text-right")}
                  aria-sort={column.sortable ? sortKey === column.key ? sortDirection === "asc" ? "ascending" : "descending" : "none" : undefined}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      className="focus-ring inline-flex items-center gap-1 rounded transition-colors hover:text-ui-text"
                      onClick={() => {
                        if (sortKey === column.key) setSortDirection((current) => current === "asc" ? "desc" : "asc");
                        else { setSortKey(column.key); setSortDirection("asc"); }
                        setPage(1);
                      }}
                    >
                      {column.header}
                      <span aria-hidden="true" className="shrink-0 text-ui-text-subtle/60">
                        {sortKey === column.key ? sortDirection === "asc" ? <ChevronUp size={13} /> : <ChevronDown size={13} /> : <ChevronsUpDown size={13} />}
                      </span>
                    </button>
                  ) : column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-ui-border/60">
            {loading ? Array.from({ length: 5 }, (_, row) => (
              <tr key={row}>{columns.map((column) => <td key={column.key} className="px-4 py-3"><Skeleton variant="text" /></td>)}</tr>
            )) : visible.length === 0 ? (
              <tr><td colSpan={columns.length}><EmptyState title={emptyMessage} /></td></tr>
            ) : visible.map((row) => (
              <tr key={row.id} className="transition-colors hover:bg-ui-bg-muted/50">
                {columns.map((column) => (
                  <td key={column.key} className={classes("px-4 py-3 text-ui-text", column.align === "center" && "text-center", column.align === "right" && "text-right")}>
                    {column.render ? column.render(row[column.key], row) : String(row[column.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-ui-border px-4 py-3">
          <span className="text-xs text-ui-text-muted">Showing {start + 1}-{Math.min(start + pageSize, sorted.length)} of {sorted.length}</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" icon={<ChevronLeft size={14} />} disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} aria-label="Previous page" />
            <Button variant="ghost" size="sm" icon={<ChevronRight size={14} />} disabled={safePage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} aria-label="Next page" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function useDarkMode(): { readonly dark: boolean; readonly toggle: () => void } {
  const [dark, setDark] = useState(() => {
    const saved = window.localStorage.getItem("projects-board.dark-mode");
    return saved === null ? window.matchMedia("(prefers-color-scheme: dark)").matches : saved === "true";
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const toggle = (): void => setDark((current) => {
    const next = !current;
    window.localStorage.setItem("projects-board.dark-mode", String(next));
    return next;
  });
  return { dark, toggle };
}

export function DarkModeToggle({ dark, onToggle }: { readonly dark: boolean; readonly onToggle: () => void }): JSX.Element {
  return (
    <button type="button" className="focus-ring rounded-xl p-2 text-ui-text-muted transition-colors hover:bg-ui-bg-muted hover:text-ui-text" aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} onClick={onToggle}>
      {dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </button>
  );
}

type ToastType = "success" | "error" | "info";
interface ToastItem { readonly id: number; readonly message: string; readonly type: ToastType }
interface ToastContextValue { readonly toast: (message: string, type?: ToastType) => void }
const ToastContext = createContext<ToastContextValue>({ toast: () => undefined });
let toastId = 0;

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++toastId;
    setItems((current) => [...current.filter((item) => item.message !== message || item.type !== type), { id, message, type }].slice(-4));
    window.setTimeout(() => dismiss(id), 4_000);
  }, [dismiss]);
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed bottom-4 right-4 z-[500] flex flex-col items-end gap-2">
        {items.map((item) => (
          <div key={item.id} role={item.type === "error" ? "alert" : "status"} className={classes("pointer-events-auto flex max-w-xs items-center gap-2 rounded-lg border border-ui-border bg-ui-bg-raised px-3 py-2.5 shadow-lg", item.type === "error" && "border-ui-danger/50")}>
            {item.type === "success" ? <CheckCircle2 size={14} className="shrink-0 text-[rgb(var(--tone-done))]" aria-hidden="true" /> : item.type === "error" ? <AlertCircle size={14} className="shrink-0 text-ui-danger" aria-hidden="true" /> : <Info size={14} className="shrink-0 text-ui-accent" aria-hidden="true" />}
            <span className="flex-1 text-xs text-ui-text-muted">{item.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(item.id)} className="focus-ring shrink-0 rounded text-ui-text-subtle hover:text-ui-text"><X size={12} aria-hidden="true" /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
