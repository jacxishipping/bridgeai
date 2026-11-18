/**
 * AI Bridge Enterprise Dashboard — Application Shell
 * Assembles SidebarNav, TopHeader, CommandPaletteModal, and primary content container.
 * Strict JXUI Primitives. ZERO inline styles.
 */

import React, { useEffect, useRef, useState } from "react";
import { BreadcrumbTrail, GlassModal, JXButton } from "../ui";
import { motion, AnimatePresence } from "motion/react";
import { Keyboard } from "lucide-react";
import { SidebarNav } from "./SidebarNav";
import { TopHeader } from "./TopHeader";
import { CommandPaletteModal } from "./CommandPaletteModal";
import { ProductGlass, ProductStatusDot } from "../ui";
import { token, sessionToken, clearCredentials, apiOrigin } from "../api";
import { useDashboardStore } from "../state/dashboardStore";
import type { ViewId } from "../types/dashboard";

/** D-01: session key recording that the demo interstitial was shown/dismissed. */
const DEMO_WARNING_KEY = "ai_bridge_demo_warning_seen";

export interface ViewMetadata {
  title: string;
  domain: string;
  breadcrumbs: string[];
}

export interface AppShellProps {
  children?: React.ReactNode;
  currentView?: ViewId;
  viewMeta?: ViewMetadata;
  /** False for views that render their own <h1> (VIEWS_WITH_OWN_HEADER). */
  showHeader?: boolean;
}

/** g-prefix navigation targets (UX-34): press g, then the letter. */
const G_PREFIX_TARGETS: Record<string, ViewId> = {
  d: "devices",
  o: "overview",
  h: "live",
  t: "task-queue-and-vision",
  w: "autonomous-workflows",
  f: "fleet-operations",
  a: "human-approvals",
  p: "security-policies",
  l: "audit-trail",
  c: "mcp-and-oauth",
  i: "ai-api-and-agents",
  s: "live-desktop-studio",
  e: "interactive-terminal",
  g: "diagnostics-and-logs",
};

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Ctrl/⌘ K", action: "Search / Command palette" },
  { keys: "g then d", action: "Go to Devices" },
  { keys: "g then h", action: "Go to Live home" },
  { keys: "g then o", action: "Go to Fleet overview" },
  { keys: "g then t", action: "Go to Tasks" },
  { keys: "g then w", action: "Go to Workflows" },
  { keys: "g then f", action: "Go to Fleet operations" },
  { keys: "g then a", action: "Go to Approvals" },
  { keys: "g then p", action: "Go to Policies" },
  { keys: "g then l", action: "Go to Audit log" },
  { keys: "g then c", action: "Go to Connections" },
  { keys: "g then i", action: "Go to AI providers" },
  { keys: "g then s", action: "Go to Desktop studio" },
  { keys: "g then e", action: "Go to Terminal" },
  { keys: "g then g", action: "Go to Logs" },
  { keys: "Ctrl/⌘ N", action: "Enroll a device (Devices view)" },
  { keys: "Ctrl/⌘ Enter", action: "Dispatch task (Tasks view)" },
  { keys: "Space", action: "Pause log stream (Logs view); veto agent intent (Desktop studio)" },
  { keys: "Esc", action: "Close modal / menu; veto agent intent (Desktop studio)" },
  { keys: "Tab", action: "Skip to main content" },
  { keys: "?", action: "Toggle this help" },
];

export const AppShell: React.FC<AppShellProps> = ({ children, currentView, viewMeta, showHeader = true }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const setCurrentView = useDashboardStore((s) => s.setCurrentView);
  const drawerRef = useRef<HTMLElement>(null);
  // The demo interstitial is for demo views only: #/live renders its own
  // unauthenticated empty state and must not get a "sample data" warning.
  const [demoWarningOpen, setDemoWarningOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return currentView !== "live" && currentView !== "login" && !token() && !sessionToken() && sessionStorage.getItem(DEMO_WARNING_KEY) !== "1";
  });
  const dismissDemoWarning = () => {
    if (typeof window !== "undefined") sessionStorage.setItem(DEMO_WARNING_KEY, "1");
    setDemoWarningOpen(false);
  };
  const mainRef = useRef<HTMLElement>(null);
  const view = window.location.hash;
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);
  useEffect(() => {
    const pendingG = { at: 0 };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && ("value" in target || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // A modal dialog owns the keyboard while open.
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "?") { setHelpOpen((prev) => !prev); return; }
      if (e.key === "g" && !menuOpen && !helpOpen) { pendingG.at = Date.now(); return; }
      if (pendingG.at && Date.now() - pendingG.at < 1000) {
        const targetView = G_PREFIX_TARGETS[e.key.toLowerCase()];
        pendingG.at = 0;
        if (targetView) { e.preventDefault(); setCurrentView(targetView); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, helpOpen, setCurrentView]);
  // Mobile drawer as a proper dialog (UX-28): role/aria-modal, Escape to
  // close, focus trap while open, focus return to the launcher on close.
  useEffect(() => {
    if (!menuOpen) return;
    const launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = drawerRef.current;
    drawer?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setMenuOpen(false); return; }
      if (e.key !== "Tab" || !drawer) return;
      const focusables = Array.from(
        drawer.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      launcher?.focus?.();
    };
  }, [menuOpen]);
  // Drawer slides from the inline-start edge so RTL mirrors it (UX-14).
  const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const drawerX = isRtl ? "100%" : "-100%";
  return (
    <div className="product-shell h-dvh w-full flex overflow-hidden text-[color:var(--product-text)]!">
      <a href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 focus:rounded-lg focus:bg-indigo-600 focus:p-3 focus:text-white">
        Skip to content
      </a>
      <aside className="hidden lg:block shrink-0"><SidebarNav /></aside>
      {/* Mobile slide-out drawer */}
      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
            />
            <motion.aside
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              tabIndex={-1}
              initial={{ x: drawerX }}
              animate={{ x: 0 }}
              exit={{ x: drawerX }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed start-0 top-0 z-50 h-dvh w-72 max-w-[85vw] bg-[var(--product-sidebar-bg)] shadow-2xl"
            >
              <SidebarNav onNavigate={() => setMenuOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
      <GlassModal open={demoWarningOpen} onClose={dismissDemoWarning} title="Simulated data — demo workspace">
        <div className="space-y-4 text-sm text-[color:var(--product-text-secondary)]">
          <p>
            Everything on this page is <strong className="text-amber-300">sample data, not a real fleet</strong>.
            The devices, metrics, approvals, tasks and audit records are generated in your browser for
            demonstration. No real computer is connected and nothing here reflects a live control plane.
          </p>
          <p>Sign in to a control plane to see your real fleet, or continue to explore the simulated demo.</p>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <JXButton variant="outlined" color="neutral" onClick={() => { dismissDemoWarning(); window.location.hash = "#/login"; }}>
              Back to sign in
            </JXButton>
            <JXButton variant="contained" color="primary" onClick={dismissDemoWarning}>
              Continue to demo
            </JXButton>
          </div>
        </div>
      </GlassModal>

      <GlassModal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts">
        <div className="space-y-3 text-sm text-[color:var(--product-text-secondary)]">
          <p className="text-xs text-[color:var(--product-text-tertiary)]">
            Shortcuts work anywhere except while typing in a field. “g then …” means press g, then the letter within a second.
          </p>
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys + shortcut.action} className="flex items-center justify-between gap-4">
              <span>{shortcut.action}</span>
              <kbd className="shrink-0 rounded border border-[color:var(--product-line)] px-1.5 py-0.5 text-xs text-[color:var(--product-text-tertiary)]">{shortcut.keys}</kbd>
            </div>
          ))}
        </div>
      </GlassModal>

      {/* Primary Viewport Column */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        {/* Sticky Control Plane Top Header */}
        <TopHeader onMenu={() => setMenuOpen(true)} onHelp={() => setHelpOpen(true)} />
        {Boolean(token() || sessionToken()) ? (
          <ProductGlass className="shrink-0 rounded-none! border-x-0! border-t-0! border-b border-emerald-800/40! bg-emerald-950/20! px-4 py-2 text-xs text-emerald-400 sm:px-6">
            <div role="note" className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ProductStatusDot status="online" pulse />
                <strong className="font-medium text-emerald-300">Live control plane</strong>
                <span className="truncate text-emerald-400/80">API {apiOrigin.replace(/^https?:\/\//, "")}</span>
              </div>
              <button type="button" onClick={() => { clearCredentials(); window.location.hash = "#/login"; window.location.reload(); }} className="text-xs text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)] underline">Sign out</button>
            </div>
          </ProductGlass>
        ) : (
          <ProductGlass className="shrink-0 rounded-none! border-x-0! border-t-0! border-b border-amber-700/50! bg-amber-950/30! px-4 py-2 text-xs text-amber-100/90 sm:px-6">
            <div role="note" className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ProductStatusDot status="warn" pulse={false} />
                <strong className="font-medium text-amber-200">SAMPLE DATA · DEMO</strong>
                <span className="text-amber-100/70">Not connected to a control plane. Metrics and devices below are simulated.</span>
              </div>
              <button type="button" onClick={() => { window.location.hash = "#/login"; }} className="shrink-0 text-xs text-indigo-300 hover:text-indigo-200 underline">Connect server</button>
            </div>
          </ProductGlass>
        )}

        {/* Scrollable Viewport Canvas with subtle entrance motion */}
        <motion.main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          className="product-content flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-3 sm:p-5 focus:outline-none"
        >
          <div className="mx-auto w-full max-w-[1440px]">
            {/* Breadcrumb on every view, including own-header views (UX-36). */}
            {viewMeta && (
              <div className="mb-6 flex flex-col justify-between gap-3 border-b border-[var(--product-line)] pb-3 md:flex-row md:items-end">
                <div className="space-y-2">
                  <BreadcrumbTrail crumbs={viewMeta.breadcrumbs} />
                  {showHeader && (
                    <h1 className="text-xl font-bold tracking-tight text-[var(--product-text)]">
                      {viewMeta.title}
                    </h1>
                  )}
                </div>
              </div>
            )}
            {children}
          </div>
        </motion.main>
      </div>

      {/* Global Command Palette Modal (⌘K) */}
      <CommandPaletteModal />
    </div>
  );
};

export default AppShell;
