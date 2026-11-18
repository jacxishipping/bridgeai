import React, { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, ListChecks, Search, Server, LogIn, ShieldCheck } from "lucide-react";
import { GlassModal, JXTextField } from "../ui";
import { useDashboardStore } from "../state/dashboardStore";
import { navigationItems } from "./navigation";
import { EMERGENCY_STOP_EVENT } from "./TopHeader";

function goLiveSection(section: string) {
  const next = `#/live?section=${section}`;
  if (window.location.hash !== next) window.location.hash = next;
  window.dispatchEvent(new Event("hashchange"));
}

export const CommandPaletteModal: React.FC = () => {
  const open = useDashboardStore((s) => s.commandPaletteOpen);
  const setOpen = useDashboardStore((s) => s.setCommandPaletteOpen);
  const navigate = useDashboardStore((s) => s.setCurrentView);
  const devices = useDashboardStore((s) => s.devices);
  const selectDevice = useDashboardStore((s) => s.setSelectedDeviceId);
  const stopped = useDashboardStore((s) => s.isEmergencyStopActive);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);
  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);

  const items = useMemo(() => [
    // Actions (UX-34): the palette executes, not just navigates. Emergency
    // stop opens the header's hold-to-confirm dialog — it never fires
    // directly from here.
    {
      id: "action-emergency-stop", label: stopped ? "Resume fleet" : "Emergency stop",
      detail: stopped ? "Clear the emergency stop (hold to confirm)" : "Halt all fleet execution (hold to confirm)",
      icon: AlertTriangle, kind: "action" as const,
      select: () => window.dispatchEvent(new Event(EMERGENCY_STOP_EVENT)),
    },
    {
      id: "action-new-task", label: "New task (live)", detail: "Dispatch a task from Live home",
      icon: ListChecks, kind: "action" as const, select: () => goLiveSection("tasks"),
    },
    {
      id: "action-approvals", label: "Review approvals (live)", detail: "Pending human approvals",
      icon: ShieldCheck, kind: "action" as const, select: () => goLiveSection("approvals"),
    },
    ...navigationItems.map((item) => ({
      id: item.id, label: item.label, detail: (item.aliases || []).join(" · "), icon: item.icon,
      kind: "page" as const, select: () => navigate(item.id),
    })),
    { id: "login", label: "Connect to server", detail: "", icon: LogIn, kind: "page" as const, select: () => navigate("login") },
    // Devices, online first (UX-34), with platform + status + last seen.
    // Mapped over the store fleet, then sorted: online devices first, then
    // most recently seen. (F3.2 pins the `devices.map((device)` shape.)
    ...devices.map((device) => ({
      id: device.id, label: device.hostname, detail: `${device.name} · ${device.platform}`,
      icon: Server, kind: "device" as const,
      status: device.status,
      lastSeenRaw: device.lastHeartbeat || "",
      lastSeen: device.lastHeartbeat
        ? new Date(device.lastHeartbeat).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : "never seen",
      select: () => { selectDevice(device.id); navigate("device-360-system"); },
    })).sort((a, b) =>
      (a.status === "online" ? 0 : 1) - (b.status === "online" ? 0 : 1) ||
      Date.parse(b.lastSeenRaw || "") - Date.parse(a.lastSeenRaw || "")),
  ], [devices, navigate, selectDevice, stopped]);
  const results = items.filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(query.toLowerCase().trim())).slice(0, 30);
  const select = (index: number) => { results[index]?.select(); setOpen(false); };
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);
  if (!open) return null;

  return <GlassModal title="Search" onClose={() => setOpen(false)}>
    <div className="space-y-4">
      <JXTextField value={query} onChange={(value) => { setQuery(value); setActive(0); }}
        role="combobox" aria-label="Search pages and devices" aria-expanded="true" aria-autocomplete="list"
        aria-controls={listId} aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
        placeholder="Pages or devices…" startIcon={<Search className="h-4 w-4" />} clearable
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => results.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0);
          } else if (event.key === "Enter") { event.preventDefault(); select(active); }
        }} />
      <div id={listId} role="listbox" aria-label="Search results" className="max-h-[45dvh] overflow-y-auto">
        {results.map((item, index) => {
          const Icon = item.icon;
          const isDevice = item.kind === "device";
          const status = isDevice ? (item as { status: string }).status : undefined;
          const lastSeen = isDevice ? (item as { lastSeen: string }).lastSeen : undefined;
          return <button key={item.id} id={`${listId}-${index}`} type="button" role="option"
            aria-selected={index === active} tabIndex={-1} onClick={() => select(index)}
            className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${index === active ? "bg-[var(--product-raised)] text-[var(--product-text)]" : "text-[var(--product-text-tertiary)] hover:bg-[var(--product-raised)]"}`}>
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block break-all">{item.label}</span>
              {item.detail && <span className="block truncate text-xs opacity-70">{item.detail}</span>}
            </span>
            {isDevice && (
              <span className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap">
                <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${status === "online" ? "bg-emerald-400" : status === "offline" ? "bg-[var(--product-text-dim)]" : "bg-amber-400"}`} />
                <span className="capitalize">{status}</span>
                <span className="opacity-70">· {lastSeen}</span>
              </span>
            )}
          </button>;
        })}
      </div>
      {results.length === 0 && <p role="status" className="py-6 text-center text-sm text-[var(--product-text-tertiary)]">No results.</p>}
    </div>
  </GlassModal>;
};
