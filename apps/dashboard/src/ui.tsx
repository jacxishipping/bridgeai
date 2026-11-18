/**
 * Product-safe compositions for JXUI 3.0.
 *
 * Some 3.0 exports are interactive showcases rather than layout primitives:
 * Stack wraps every child in a bordered tile; Badge adds a notification bell;
 * LinearProgress includes build-demo controls. Keep those defaults out of the
 * control plane while retaining JXUI surfaces, buttons, inputs and tokens.
 * Native dialog supplies the focus trap, inert background and Escape behavior
 * missing from GlassModal. Remove these adapters when upstream supports them.
 */
import React, { useEffect, useId, useRef, useState } from "react";
import {
  AdaptiveGlass,
  BentoGrid,
  BreadcrumbTrail,
  FloatingActionButton,
  FrostedGlass,
  GlassToolbar,
  HoldToConfirmButton,
  InteractiveCard,
  MagneticButton,
  NumberCounter,
  ShimmerButton,
  SlideToAction,
  TiltCard,
  JXAlert as Alert, JXBox, JXButton as Button, JXCard as Card, JXChip, JXTabs as Tabs, JXTextField as TextField,
} from "@jacxishippingorg/jx-ui-react";
import { AlertTriangle, Ban, CheckCircle2, CircleHelp, CircleMinus, Clock, FileText, Hourglass, Info, Pause, Play, RefreshCw, ShieldAlert, ShieldCheck, TrendingUp, TrendingDown, Minus, X, XCircle, Wifi, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export * from "@jacxishippingorg/jx-ui-react";
export {
  AdaptiveGlass,
  BentoGrid,
  BreadcrumbTrail,
  FloatingActionButton,
  FrostedGlass,
  GlassToolbar,
  HoldToConfirmButton,
  InteractiveCard,
  MagneticButton,
  NumberCounter,
  ShimmerButton,
  SlideToAction,
  TiltCard,
};

export function JXAlert(props: React.ComponentProps<typeof Alert>) {
  return <Alert {...props} technicalDetails={props.technicalDetails ?? ""} actionLabel={props.actionLabel ?? ""} />;
}

// v3.0's lockWidth forces every control to at least 180px, including icons and
// controls in narrow grids. Use content sizing; loading labels remain explicit.
export function JXButton(props: React.ComponentProps<typeof Button> & { tactile?: boolean }) {
  const { tactile, ...rest } = props;
  return <Button {...rest} lockWidth={false} halo={Boolean(tactile)} spring={Boolean(tactile)}
    data-tone={props.color || "primary"} data-variant={props.variant || "contained"}
    className={`product-button max-w-full whitespace-normal! h-auto! ${tactile ? "" : "shadow-none!"} rounded-md! ${props.className || ""}`} />;
}

/** Compact operational metric tile built on InteractiveCard (JXUI advanced). */
export function ProductMetricCard({
  label, value, hint, trend, onClick, className = "",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  trend?: "up" | "down" | "flat";
  onClick?: () => void;
  className?: string;
}) {
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendTone = trend === "up" ? "text-emerald-400" : trend === "down" ? "text-rose-400" : "text-[var(--product-text-tertiary)]";
  const numeric = typeof value === "number" ? value : null;
  return (
    <InteractiveCard
      hoverLift
      className={`product-surface rounded-xl! border border-[var(--product-line)]! bg-[var(--product-surface)]/70! p-0! shadow-none! ${className}`}
    >
      <button type="button" onClick={onClick} className="flex w-full flex-col gap-1 p-4 text-left">
        <span className="text-xs font-medium text-[var(--product-text-tertiary)]">{label}</span>
        <span className="flex items-baseline gap-2">
          {numeric !== null ? (
            <span className="[&>div]:text-[var(--product-text)]! [&>div]:text-2xl! [&>div]:font-semibold!">
              <NumberCounter value={numeric} />
            </span>
          ) : (
            <span className="font-mono text-2xl font-semibold tabular-nums text-[var(--product-text)]">{value}</span>
          )}
          {trend && <TrendIcon className={`h-3.5 w-3.5 ${trendTone}`} aria-hidden="true" />}
        </span>
        {hint && <span className="text-[11px] text-[var(--product-text-dim)]">{hint}</span>}
      </button>
    </InteractiveCard>
  );
}

/** Glass surface for hero / wizard panels without breaking operational density elsewhere. */
export function ProductGlass({ children, className = "" }: React.PropsWithChildren<{ className?: string }>) {
  return (
    <AdaptiveGlass className={`rounded-xl border border-[var(--product-line)] bg-[var(--product-surface)]/50 ${className}`}>
      {children}
    </AdaptiveGlass>
  );
}

/** Status radar — product wrapper because library PulseIndicator/StatusIndicator are fixed demos. */
export function ProductStatusDot({
  status = "online",
  label,
  pulse = true,
  className = "",
}: {
  status?: "online" | "offline" | "warn" | "idle";
  label?: string;
  pulse?: boolean;
  className?: string;
}) {
  const tone =
    status === "online" ? "bg-emerald-400" :
    status === "warn" ? "bg-amber-400" :
    status === "idle" ? "bg-slate-400" :
    "bg-rose-500";
  const text =
    status === "online" ? "text-emerald-400" :
    status === "warn" ? "text-amber-400" :
    status === "idle" ? "text-[var(--product-text-tertiary)]" :
    "text-rose-400";
  // No role="status" here (UX-37): the dot is permanently rendered and
  // poll-driven, so a live region on it would re-announce on every poll.
  // Call sites that must announce wrap it in their own role="status"
  // (Freshness, ConnectionsView probe wrappers).
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
        {pulse && status === "online" && (
          <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${tone}`} />
        )}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${tone}`} />
      </span>
      {label && <span className={`text-[11px] font-semibold ${text}`}>{label}</span>}
    </span>
  );
}

/** Sliding pill selector — SegmentedControl in the package is a Daily/Weekly stub. */
export function ProductSegmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel = "Options",
  className = "",
}: {
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-[var(--product-line)] bg-[var(--product-raised)]/80 p-1 ${className}`}
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.id)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-mono transition-all ${
              active
                ? "bg-indigo-600 font-semibold text-white shadow-sm"
                : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Live / demo island pill (ConnectionStatus / LiveActivity in the package are hardcoded). */
export function ProductModePill({
  live,
  detail,
  className = "",
}: {
  live: boolean;
  detail?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs shadow-sm ${
        live
          ? "border-emerald-500/40 bg-emerald-950/50 text-emerald-200"
          : "border-amber-500/40 bg-amber-950/40 text-amber-100"
      } ${className}`}
    >
      {live ? <Wifi className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      <ProductStatusDot status={live ? "online" : "warn"} pulse={live} />
      <span className="font-medium">{live ? "Live" : "Demo"}</span>
      {detail && <span className="max-w-[14rem] truncate opacity-80">{detail}</span>}
    </span>
  );
}

/** Compact glass notice for post-action feedback. */
export function ProductNotice({
  children,
  tone = "info",
  className = "",
}: React.PropsWithChildren<{ tone?: "info" | "success" | "warning" | "error"; className?: string }>) {
  const tones = {
    info: "border-indigo-500/30 bg-indigo-500/10 text-indigo-200",
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    warning: "border-amber-500/30 bg-amber-500/10 text-amber-100",
    error: "border-rose-500/30 bg-rose-500/10 text-rose-200",
  };
  return (
    <div role="status">
      <ProductGlass className={`px-3 py-2 text-xs font-mono ${tones[tone]} ${className}`}>
        {children}
      </ProductGlass>
    </div>
  );
}

/** Wizard / enrollment step rail — MultiStepProgress in the package is a fixed demo. */
export function ProductStepProgress({
  steps,
  current,
  className = "",
}: {
  steps: string[];
  current: number;
  className?: string;
}) {
  return (
    <ol className={`flex flex-wrap items-center gap-2 text-xs ${className}`} aria-label="Progress">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={step} className="flex items-center gap-2">
            {index > 0 && (
              <span className={`h-0.5 w-5 ${done || active ? "bg-indigo-500" : "bg-[var(--product-line)]"}`} aria-hidden="true" />
            )}
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                done || active
                  ? "bg-indigo-600 text-white"
                  : "bg-[var(--product-raised)] text-[var(--product-text-tertiary)]"
              }`}
              aria-current={active ? "step" : undefined}
            >
              {index + 1}
            </span>
            <span className={active ? "font-semibold text-[var(--product-text)]" : "text-[var(--product-text-tertiary)]"}>
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Dense filter/action strip on AdaptiveGlass. */
export function ProductToolbar({ children, className = "" }: React.PropsWithChildren<{ className?: string }>) {
  return (
    <GlassToolbar>
      <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>
    </GlassToolbar>
  );
}

export function JXStack({ direction = "row", spacing = "sm", className = "", children, ...props }:
  React.HTMLAttributes<HTMLDivElement> & { direction?: "row" | "col"; spacing?: "xs" | "sm" | "md" | "lg" }) {
  const gap = { xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-4" }[spacing];
  return <div {...props} className={`flex min-w-0 ${direction === "col" ? "flex-col" : "flex-row"} ${gap} ${className}`}>{children}</div>;
}

export function JXGridItem({ colSpan = 12, rowSpan, className = "", ...props }:
  React.HTMLAttributes<HTMLDivElement> & { colSpan?: number; rowSpan?: number }) {
  const span: Record<number, string> = {
    3: "col-span-12 sm:col-span-6 xl:col-span-3",
    4: "col-span-12 lg:col-span-4", 5: "col-span-12 xl:col-span-5",
    6: "col-span-12 lg:col-span-6", 7: "col-span-12 xl:col-span-7",
    8: "col-span-12 lg:col-span-8", 12: "col-span-12",
  };
  return <div {...props} className={`min-w-0 ${span[colSpan] || "col-span-12"} ${rowSpan === 2 ? "row-span-2" : ""} ${className}`} />;
}

export function JXCard(props: React.ComponentProps<typeof Card>) {
  return <Card {...props} spotlight={false} hoverLift={false} className={`product-surface rounded-xl! shadow-none! ${props.className || ""}`} />;
}

/** Use normal title/body hierarchy instead of the library's accent kicker. */
export function JXCardHeader({ title, subheader, icon }: { title: string; subheader?: string; icon?: React.ReactNode }) {
  return <div className="mb-3 flex items-start justify-between gap-3">
    <div className="min-w-0">
      <h2 className="text-sm font-semibold text-[color:var(--product-text)]">{title}</h2>
      {subheader && <p className="mt-1 text-xs leading-relaxed text-[color:var(--product-text-tertiary)]">{subheader}</p>}
    </div>
    {icon && <span aria-hidden="true" className="shrink-0 text-[color:var(--product-text-tertiary)]">{icon}</span>}
  </div>;
}

export function JXBadge({ color = "primary", statusText, count, children, className = "" }:
  React.PropsWithChildren<{ color?: string; statusText?: string; count?: number; className?: string }>) {
  const tones = { primary: "indigo", success: "emerald", warning: "amber", error: "rose", neutral: "neutral" } as const;
  return <JXChip tone={tones[color as keyof typeof tones] || "neutral"} label={String(statusText ?? children ?? count ?? 0)} className={`text-[11px] ${className}`} />;
}

/**
 * Shared status → tone map (UX-05). One canonical code for every semantic
 * state in the app, so the same state never gets a different colour on a
 * different screen. Colours use the existing status palette only: emerald
 * for success/completed/online, cyan for running/active, rose for
 * failed/error/denied/revoked, amber for warning/pending/degraded, indigo
 * ONLY for info (the colour ProductNotice already uses for info), and
 * theme tokens for neutral states. Keys are matched case-insensitively;
 * spaces and hyphens normalise to underscores ("Pending approval" →
 * "pending_approval"). Unknown keys fall back to the neutral tone and
 * render the raw status text, humanised.
 *
 * View sites must NOT keep their own getStatusBadge/statusClass helpers:
 * use <StatusBadge status={...} /> instead.
 */
export interface StatusTone {
  background: string;
  border: string;
  text: string;
  icon: LucideIcon;
  label: string;
  /** Spins the icon (running states). */
  spin?: boolean;
}

export const STATUS_TONES: Record<string, StatusTone> = {
  // Task states
  queued: { background: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-300", icon: Hourglass, label: "Queued" },
  running: { background: "bg-cyan-500/15", border: "border-cyan-500/30", text: "text-cyan-300", icon: RefreshCw, label: "Running", spin: true },
  completed: { background: "bg-emerald-500/15", border: "border-emerald-500/30", text: "text-emerald-300", icon: CheckCircle2, label: "Completed" },
  failed: { background: "bg-rose-500/15", border: "border-rose-500/30", text: "text-rose-300", icon: XCircle, label: "Failed" },
  cancelled: { background: "bg-[var(--product-raised)]/70", border: "border-[var(--product-line)]", text: "text-[var(--product-text-tertiary)]", icon: Ban, label: "Cancelled" },
  pending: { background: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-300", icon: Clock, label: "Pending" },
  pending_approval: { background: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-300", icon: Clock, label: "Pending approval" },
  approved: { background: "bg-emerald-500/15", border: "border-emerald-500/30", text: "text-emerald-300", icon: ShieldCheck, label: "Approved" },
  denied: { background: "bg-rose-500/15", border: "border-rose-500/30", text: "text-rose-300", icon: ShieldAlert, label: "Denied" },
  // Device states
  online: { background: "bg-emerald-500/15", border: "border-emerald-500/30", text: "text-emerald-300", icon: Wifi, label: "Online" },
  offline: { background: "bg-[var(--product-raised)]/70", border: "border-[var(--product-line)]", text: "text-[var(--product-text-tertiary)]", icon: WifiOff, label: "Offline" },
  degraded: { background: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-300", icon: AlertTriangle, label: "Degraded" },
  revoked: { background: "bg-rose-500/15", border: "border-rose-500/30", text: "text-rose-300", icon: Ban, label: "Revoked" },
  unknown: { background: "bg-[var(--product-raised)]/70", border: "border-[var(--product-line)]", text: "text-[var(--product-text-tertiary)]", icon: CircleHelp, label: "Unknown" },
  // Workflow states
  draft: { background: "bg-[var(--product-raised)]/70", border: "border-[var(--product-line)]", text: "text-[var(--product-text-tertiary)]", icon: FileText, label: "Draft" },
  active: { background: "bg-cyan-500/15", border: "border-cyan-500/30", text: "text-cyan-300", icon: Play, label: "Active" },
  paused: { background: "bg-[var(--product-raised)]/70", border: "border-[var(--product-line)]", text: "text-[var(--product-text-tertiary)]", icon: Pause, label: "Paused" },
  aborted: { background: "bg-[var(--product-raised)]/70", border: "border-[var(--product-line)]", text: "text-[var(--product-text-tertiary)]", icon: Ban, label: "Aborted" },
  skipped: { background: "bg-[var(--product-raised)]/70", border: "border-[var(--product-line)]", text: "text-[var(--product-text-tertiary)]", icon: CircleMinus, label: "Skipped" },
  // Generic tones
  success: { background: "bg-emerald-500/15", border: "border-emerald-500/30", text: "text-emerald-300", icon: CheckCircle2, label: "Success" },
  error: { background: "bg-rose-500/15", border: "border-rose-500/30", text: "text-rose-300", icon: XCircle, label: "Error" },
  warning: { background: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-300", icon: AlertTriangle, label: "Warning" },
  info: { background: "bg-indigo-500/15", border: "border-indigo-500/30", text: "text-indigo-300", icon: Info, label: "Info" },
  neutral: { background: "bg-[var(--product-raised)]/70", border: "border-[var(--product-line)]", text: "text-[var(--product-text-tertiary)]", icon: CircleMinus, label: "Neutral" },
};

/** Normalise a caller-supplied status to a STATUS_TONES key. */
export function normalizeStatusKey(status: string): string {
  return status.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function humanizeStatus(status: string): string {
  const cleaned = status.trim().replace(/[_-]+/g, " ");
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "Unknown";
}

/**
 * Single shared status badge (UX-05). `status` is the canonical key
 * (case-insensitive, e.g. "running", "Pending approval", "FAILED").
 * Unknown statuses render in the neutral tone with the raw status as the
 * label, so a new backend status never renders blank. `label` overrides
 * the tone's default label.
 */
export function StatusBadge({ status, size = "sm", label }: {
  status: string;
  size?: "sm" | "md";
  label?: string;
}) {
  const key = normalizeStatusKey(status);
  const known = Object.prototype.hasOwnProperty.call(STATUS_TONES, key);
  const tone = STATUS_TONES[key] ?? STATUS_TONES.neutral;
  const Icon = tone.icon;
  const display = label ?? (known ? tone.label : humanizeStatus(status));
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold whitespace-nowrap ${tone.background} ${tone.border} ${tone.text} ${size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]"}`}
    >
      <Icon className={`${size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"} shrink-0 ${tone.spin ? "animate-spin" : ""}`} aria-hidden="true" />
      {display}
    </span>
  );
}

export function JXTextField(props: React.ComponentProps<typeof TextField>) {
  return <TextField {...props} showCharacterCounter={false} maxLength={props.maxLength ?? 4096}
    aria-label={props["aria-label"] || (typeof props.label === "string" ? props.label : props.placeholder) || "Text input"} />;
}

export function JXTabs({ tabs = [], value, defaultValue, onChange, className = "" }: React.ComponentProps<typeof Tabs>) {
  const [local, setLocal] = useState(defaultValue || tabs[0]?.id);
  const current = value ?? local;
  return <div className={`space-y-3 ${className}`}>
    <div role="group" aria-label="View sections" className="flex flex-wrap gap-2 rounded-xl bg-[var(--product-raised)] p-1"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
          (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
        buttons[next]?.click();
      }}>
      {tabs.map((tab) => <JXButton key={tab.id} variant={current === tab.id ? "contained" : "text"}
        color={current === tab.id ? "primary" : "neutral"} aria-pressed={current === tab.id}
        startIcon={tab.icon} onClick={() => { setLocal(tab.id); onChange?.(tab.id); }}>{tab.label}</JXButton>)}
    </div>
    {tabs.find((tab) => tab.id === current)?.content}
  </div>;
}

export function JXLinearProgress({ value = 0, label = "Progress", className = "" }:
  { value?: number; label?: string; className?: string }) {
  return <progress aria-label={label} max={100} value={Math.min(100, Math.max(0, value))}
    className={`block w-full h-2 overflow-hidden rounded-full ${className}`}>{value}%</progress>;
}

export function GlassModal({ open = true, onClose, title, children, closeLabel = "Close dialog" }:
  React.PropsWithChildren<{ open?: boolean; onClose?: () => void; title?: string; closeLabel?: string }>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const route = window.location.hash;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("input:not([disabled]), textarea, select")?.focus();
    }
    if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
      queueMicrotask(() => {
        if (launcher?.isConnected && route === window.location.hash) launcher.focus();
      });
    };
  }, [open]);
  return <dialog ref={ref} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); close.current?.(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close.current?.(); }}
    className="product-dialog m-auto w-[calc(100%-2rem)] max-w-2xl max-h-[90dvh] overflow-y-auto rounded-xl border border-[color:var(--product-line)]! p-0 text-[color:var(--product-text)]! shadow-2xl backdrop:backdrop-blur-sm"
    data-dialog-backdrop>
    <JXBox padding="lg" border={false} className="min-w-0">
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 id={titleId} className="text-base font-semibold">{title}</h2>
        <button type="button" onClick={onClose} aria-label={closeLabel}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[color:var(--product-text-tertiary)] hover:bg-[var(--product-raised)]">
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      {open && children}
    </JXBox>
  </dialog>;
}

/**
 * One confirmation dialog for every irreversible action (UX-03/UX-04/
 * UX-22). Built on GlassModal, so it inherits the native <dialog> focus
 * trap, Escape, backdrop-click close, and focus return. Shows the target
 * object and the plain-language consequence BEFORE the user confirms;
 * never use window.confirm for destructive actions.
 *
 * - `requireHold` swaps the plain confirm button for a HoldToConfirmButton
 *   (1200 ms, the emergency-stop standard): use it for Tier 3/4 dispatch
 *   and for "Unrestricted" policy changes.
 * - `tone="error"` (default) is for irreversible destruction; use
 *   `tone="warning"` for reversible-but-risky actions.
 * Views wire this in by holding the pending action in state and calling
 * onConfirm only from here; onCancel just closes the dialog.
 */
export interface ConfirmDestructiveProps {
  open: boolean;
  title: string;
  /** The object the action applies to, e.g. device hostname or task id. */
  objectName?: string;
  /** Plain-language consequence, e.g. "This permanently deletes the device record. The device can re-enroll." */
  consequence: string;
  /** Confirm button label, e.g. "Delete device". */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** When true, the confirm button requires a 1200 ms hold instead of a click. */
  requireHold?: boolean;
  tone?: "error" | "warning";
}

export function ConfirmDestructive({
  open,
  title,
  objectName,
  consequence,
  confirmLabel,
  onConfirm,
  onCancel,
  requireHold = false,
  tone = "error",
}: ConfirmDestructiveProps) {
  const isError = tone !== "warning";
  return (
    <GlassModal open={open} onClose={onCancel} title={title}>
      <div className="space-y-4">
        {objectName && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-[color:var(--product-text-tertiary)]">Applies to</p>
            <p className="rounded-lg border border-[color:var(--product-line)] bg-[var(--product-raised)]/60 px-3 py-2 font-mono text-xs break-all text-[color:var(--product-text)]">
              {objectName}
            </p>
          </div>
        )}
        <p className="flex items-start gap-3 text-sm leading-relaxed text-[color:var(--product-text-secondary)]">
          <AlertTriangle
            className={`h-5 w-5 shrink-0 ${isError ? "text-rose-400" : "text-amber-400"}`}
            aria-hidden="true"
          />
          {consequence}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <JXButton variant="outlined" color="neutral" onClick={onCancel}>
            Cancel
          </JXButton>
          {requireHold ? (
            <HoldToConfirmButton
              label={confirmLabel}
              tone={isError ? "danger" : "warning"}
              variant="solid"
              holdDurationMs={1200}
              onConfirm={onConfirm}
            />
          ) : (
            <JXButton variant="contained" color={isError ? "error" : "warning"} onClick={onConfirm}>
              {confirmLabel}
            </JXButton>
          )}
        </div>
      </div>
    </GlassModal>
  );
}

/**
 * Single shared empty state (UX-35). Replaces the two parallel components
 * (PageEmpty card + live Empty bare) and the ~12 inline bare variants.
 * `variant="card"` renders the glass-card form (PageEmpty); `variant="bare"`
 * renders the plain centred form (live Empty). Keep the specific, actionable
 * copy at the call site; this component only standardises presentation.
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  demo = false,
  variant = "card",
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  demo?: boolean;
  variant?: "card" | "bare";
}) {
  const body = (
    <div role="status" className="flex flex-col items-center justify-center gap-3 text-center">
      {demo && (
        <span className="rounded-full border border-amber-500/40 bg-amber-950/40 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-200">
          Sample data mode
        </span>
      )}
      <h3 className="text-base font-semibold text-[var(--product-text)]">{title}</h3>
      {description && (
        <p className="max-w-md text-sm text-[var(--product-text-tertiary)]">{description}</p>
      )}
      {(actionLabel || secondaryLabel) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {actionLabel && onAction && (
            <MagneticButton
              variant="solid"
              tone="primary"
              className="inline-flex items-center rounded-xl px-4 py-2 text-sm"
              onClick={onAction}
            >
              {actionLabel}
            </MagneticButton>
          )}
          {secondaryLabel && onSecondary && (
            <JXButton variant="outlined" color="neutral" onClick={onSecondary}>{secondaryLabel}</JXButton>
          )}
        </div>
      )}
    </div>
  );
  if (variant === "bare") {
    return <div className="space-y-3 py-10 text-center">{body}</div>;
  }
  return <ProductGlass className="px-6 py-12">{body}</ProductGlass>;
}
