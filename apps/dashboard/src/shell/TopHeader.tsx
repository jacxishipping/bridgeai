import React, { useEffect, useState } from "react";
import { AlertTriangle, CircleHelp, Menu, Search, Square, Play } from "lucide-react";
import { GlassModal, GlassToolbar, HoldToConfirmButton, JXButton, ProductModePill, ProductStatusDot } from "../ui";
import { Brand } from "../Brand";
import { DensityControl } from "../DensityControl";
import { LanguageControl } from "../LanguageControl";
import { ThemeControl } from "../ThemeControl";
import { useDashboardStore } from "../state/dashboardStore";
import { token, sessionToken } from "../api";

/**
 * The ONE emergency-stop confirmation (UX-22), shared by the TopHeader and
 * LiveControlView so both paths show the same copy, the same consequence,
 * and the same hold-to-confirm. `holdDurationMs` defaults to 1200 ms (the
 * live standard); the TopHeader passes 1200 live / 700 demo, matching the
 * pinned F4.1 behaviour for the demo path. Never trigger the stop from
 * anywhere except this component's onConfirm.
 */
export function EmergencyStopConfirm({
  open,
  stopped,
  isLive,
  title,
  consequence,
  confirmLabel,
  holdDurationMs = 1200,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  stopped: boolean;
  isLive: boolean;
  title?: string;
  consequence?: string;
  confirmLabel?: string;
  holdDurationMs?: number;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <GlassModal
      open={open}
      onClose={onClose}
      title={
        title ??
        (stopped
          ? isLive
            ? "Resume live fleet?"
            : "Resume sample demo?"
          : isLive
            ? "Activate Emergency All-Stop?"
            : "Stop sample demo tasks?")
      }
    >
      <div className="space-y-5">
        {!isLive && (
          <p className="rounded-lg border border-amber-700/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
            Demo only — this does not control real enrolled devices.
          </p>
        )}
        <p className="flex items-start gap-3 text-sm leading-relaxed text-[color:var(--product-text-secondary)]">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
          {consequence ??
            (isLive
              ? stopped
                ? "Clear the global Emergency All-Stop on the control plane and allow enrolled devices to resume picking up queued tasks."
                : "Immediately halt all autonomous agent execution across every enrolled device connected to the control plane."
              : stopped
                ? "Resume the simulated fleet. Cancelled sample tasks will not restart."
                : "Cancel pending and running sample tasks in this browser only. Real computers are not affected.")}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {error && (
            <p role="alert" className="w-full rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          )}
          <JXButton variant="outlined" color="neutral" onClick={onClose}>Cancel</JXButton>
          <HoldToConfirmButton
            label={
              confirmLabel ??
              (stopped
                ? isLive
                  ? "Hold to resume fleet"
                  : "Hold to resume demo"
                : isLive
                  ? "Hold for Emergency All-Stop"
                  : "Hold to stop demo tasks")
            }
            tone={stopped ? "success" : "danger"}
            variant="solid"
            holdDurationMs={holdDurationMs}
            onConfirm={onConfirm}
          />
        </div>
      </div>
    </GlassModal>
  );
}

/** Custom event the command palette dispatches to open this confirm (UX-34). */
export const EMERGENCY_STOP_EVENT = "ai-bridge:open-emergency-stop";

export const TopHeader: React.FC<{ onMenu: () => void; onHelp?: () => void }> = ({ onMenu, onHelp }) => {
  const isLive = typeof window !== "undefined" && Boolean(token() || sessionToken());
  const stopped = useDashboardStore((s) => s.isEmergencyStopActive);
  const stop = useDashboardStore((s) => s.triggerEmergencyStop);
  const resume = useDashboardStore((s) => s.resumeFleet);
  const setCommandPaletteOpen = useDashboardStore((s) => s.setCommandPaletteOpen);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";
  useEffect(() => {
    const open = () => { setStopError(null); setConfirmOpen(true); };
    window.addEventListener(EMERGENCY_STOP_EVENT, open);
    return () => window.removeEventListener(EMERGENCY_STOP_EVENT, open);
  }, []);

  return (
    <header className="product-topbar flex min-h-14 shrink-0 items-center gap-2 px-3 py-2 sm:px-5">
      <button type="button" onClick={onMenu} aria-label="Open navigation"
        className="lg:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[color:var(--product-line)] hover:bg-[var(--product-raised)]">
        <Menu className="h-5 w-5 text-[color:var(--product-text)]" />
      </button>
      <div className="hidden min-[360px]:block lg:hidden"><Brand compact /></div>
      <JXButton variant="outlined" color="neutral" size="sm"
        onClick={() => setCommandPaletteOpen(true)}
        aria-label="Search pages and devices"
        className="product-search min-w-0! flex-1! max-w-xl! justify-start! text-[color:var(--product-text-tertiary)]!"
        startIcon={<Search className="h-4 w-4 shrink-0" />}>
        <span className="flex items-center justify-between gap-2">
          <span className="hidden min-[480px]:inline">Search</span>
          <kbd className="hidden md:inline rounded border border-[color:var(--product-line)] px-1.5 py-0.5 text-xs text-[color:var(--product-text-dim)]">{shortcut}</kbd>
        </span>
      </JXButton>
      <div className="hidden flex-1 lg:block" />
      {/* Mode pill is always visible (UX-39): below xl it was hidden, so most
          laptops/tablets showed no Live/Demo signal in the header. */}
      <ProductModePill live={isLive} />
      <GlassToolbar>
        <LanguageControl />
        <div className="hidden md:block"><DensityControl /></div>
        <ThemeControl />
        <JXButton variant="outlined" color="neutral" size="sm" onClick={() => onHelp?.()}
          aria-label="Keyboard shortcuts and help"
          title="Keyboard shortcuts and help (?)">
          <CircleHelp className="h-4 w-4" aria-hidden="true" />
        </JXButton>
      </GlassToolbar>
      <JXButton variant="outlined" color={stopped ? "success" : "error"} size="sm"
        onClick={() => { setStopError(null); setConfirmOpen(true); }}
        aria-label={stopped ? (isLive ? "Resume Fleet" : "Resume demo fleet") : "Emergency All-Stop"}
        startIcon={stopped ? <Play className="h-4 w-4" /> : <Square className="h-4 w-4" />}>
        <span className="inline-flex items-center gap-1.5">
          <ProductStatusDot status={stopped ? "warn" : "online"} pulse={!stopped} />
          <span className="hidden sm:inline">{stopped ? (isLive ? "Resume fleet" : "Resume demo") : "Emergency stop"}</span>
          <span className="sm:hidden">{stopped ? "Resume" : "Stop"}</span>
        </span>
      </JXButton>
      <EmergencyStopConfirm
        open={confirmOpen}
        stopped={stopped}
        isLive={isLive}
        holdDurationMs={isLive ? 1200 : 700}
        error={stopError}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          setStopError(null);
          try {
            if (stopped) await resume(); else await stop();
            setConfirmOpen(false);
          } catch (err: any) {
            setStopError(err?.message || "Failed to update control-plane emergency state.");
          }
        }}
      />
      <span role="status" className="sr-only">{stopped ? (isLive ? "EMERGENCY ALL-STOP ACTIVE — FLEET SUSPENDED" : "Demo fleet stopped") : (isLive ? "Live fleet running" : "Demo fleet running")}</span>
    </header>
  );
};
