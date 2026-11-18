/**
 * AI Bridge Enterprise Dashboard — DevicesView (Screen 2)
 * Enrolled Devices & Cross-Platform Agent Enroller (SmartDataTable Inventory).
 * Pure @jacxishippingorg/jx-ui-react, motion/react, and lucide-react. ZERO inline styles.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { motion } from "motion/react";
import { useScrollShadow } from "../hooks/useScrollShadow";
import {
  JXContainer,
  JXStack,
  JXGrid,
  JXGridItem,
  JXCard,
  JXCardHeader,
  JXCardContent,
  JXBadge,
  JXButton,
  JXChip,
  JXTextField,
  JXTabs,
  GlassModal,
  BreadcrumbTrail,
  FloatingActionButton,
  MagneticButton,
  ProductGlass,
  ProductMetricCard,
  ProductModePill,
  ProductNotice,
  ProductSegmented,
  ProductStepProgress,
  StatusBadge,
  ConfirmDestructive,
  EmptyState,
} from "../ui";
import { Freshness } from "../components/Freshness";
import { pushNotice } from "../state/notices";
import { useLanguage } from "../i18n";
import {
  Server,
  Activity,
  Shield,
  Zap,
  Terminal,
  Monitor,
  Laptop,
  Search,
  PlusCircle,
  KeyRound,
  RotateCcw,
  RefreshCw,
  Check,
  Copy,
  ArrowRight,
  Filter,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Play,
  HardDrive,
  Cpu,
  Ban,
  Trash2,
} from "lucide-react";
import { api, apiOrigin, token, sessionToken } from "../api";
import { tokenExpiryStatus } from "../state/tokenExpiry";
import { useDashboardStore } from "../state/dashboardStore";
import type { EnrolledDevice, PlatformType, DeviceStatus } from "../types/dashboard";

export const DevicesView: React.FC = () => {
  const devices = useDashboardStore((s) => s.devices);
  const selectedDeviceId = useDashboardStore((s) => s.selectedDeviceId);
  const setSelectedDeviceId = useDashboardStore((s) => s.setSelectedDeviceId);
  const setCurrentView = useDashboardStore((s) => s.setCurrentView);
  const dispatchTask = useDashboardStore((s) => s.dispatchTask);
  const refreshLive = useDashboardStore((s) => s.refreshLive);
  const syncState = useDashboardStore((s) => s.syncState);
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const syncError = useDashboardStore((s) => s.syncError);
  const getSyncState = useDashboardStore((s) => s.getSyncState);
  const { date: formatDate } = useLanguage();
  const isLive = typeof window !== "undefined" && Boolean(token() || sessionToken());
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const scrollShadow = useScrollShadow(tableScrollRef);

  // Filter toolbar state
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline" | "unresponsive">("all");
  const [platformFilter, setPlatformFilter] = useState<"all" | "windows" | "linux" | "darwin">("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sortField, setSortField] = useState<"hostname" | "latency" | "heartbeat" | "tokenExpiry">("hostname");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Enrollment Modal state
  const [enrollModalOpen, setEnrollModalOpen] = useState<boolean>(false);
  const [enrollPlatformTab, setEnrollPlatformTab] = useState<string>("linux");
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [clipboardError, setClipboardError] = useState("");
  const [enrollDeviceName, setEnrollDeviceName] = useState<string>("edge-worker-node");
  const [tokenProvisioned, setTokenProvisioned] = useState<boolean>(false);
  const [enrolledToken, setEnrolledToken] = useState<string>("");
  const [showEnrolledToken, setShowEnrolledToken] = useState<boolean>(false);
  const [enrolledDeviceId, setEnrolledDeviceId] = useState<string>("");
  const [enrollError, setEnrollError] = useState<string>("");
  const [isEnrolling, setIsEnrolling] = useState<boolean>(false);

  // Quick Dispatch Modal state
  const [dispatchModalDevice, setDispatchModalDevice] = useState<EnrolledDevice | null>(null);
  const [dispatchTool, setDispatchTool] = useState<string>("capture_desktop_screenshot");
  const [dispatchConfirm, setDispatchConfirm] = useState<boolean>(false);

  // Destructive-action confirmation + busy state (UX-03/UX-23)
  const [confirmAction, setConfirmAction] = useState<{ kind: "revoke" | "delete"; device: EnrolledDevice } | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<{ kind: "revoke" | "delete"; devices: EnrolledDevice[] } | null>(null);
  const [pendingAction, setPendingAction] = useState<{ kind: string; id: string } | null>(null);

  // P1-3: device-token rotation. The new token is shown ONCE in the modal
  // below and held only in this component's state — it is never written
  // to localStorage, the store, or the URL, and is cleared on dismiss.
  const [rotateConfirm, setRotateConfirm] = useState<EnrolledDevice | null>(null);
  const [rotatedToken, setRotatedToken] = useState<{ device: EnrolledDevice; token: string; expiresAt: number } | null>(null);
  const [copiedRotatedToken, setCopiedRotatedToken] = useState(false);
  // P1-3: the rotate endpoint is admin-only; gate the button on api.me()
  // reporting role "admin", fail-closed (false) when me() fails. The
  // server still enforces admin on the call itself.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let active = true;
    if (!isLive) { setIsAdmin(false); return; }
    api.me()
      .then((me: any) => { if (active) setIsAdmin(me?.role === "admin"); })
      .catch(() => { if (active) setIsAdmin(false); });
    return () => { active = false; };
  }, [isLive]);

  // Metrics counters
  const totalCount = devices.length;
  const onlineCount = useMemo(() => devices.filter((d) => d.status === "online").length, [devices]);
  const offlineCount = useMemo(() => devices.filter((d) => d.status === "offline").length, [devices]);
  const unresponsiveCount = useMemo(() => devices.filter((d) => d.status === "unresponsive").length, [devices]);
  const windowsCount = useMemo(() => devices.filter((d) => d.platform === "windows").length, [devices]);
  const linuxCount = useMemo(() => devices.filter((d) => d.platform === "linux").length, [devices]);
  const macCount = useMemo(() => devices.filter((d) => d.platform === "darwin").length, [devices]);

  // (UX-34) No Ctrl/⌘N binding: it hijacked the browser's new-window shortcut.

  // Group / tag filter options, derived the same way as the live
  // Inventory (distinct groups / tags from the loaded devices).
  const deviceGroups = useMemo(
    () =>
      [...new Set(devices.map((d) => (d as unknown as { group?: string }).group).filter((g): g is string => Boolean(g)))].sort(),
    [devices]
  );
  const deviceTags = useMemo(() => [...new Set(devices.flatMap((d) => d.tags || []))].sort(), [devices]);
  const selectedDevices = useMemo(
    () => devices.filter((d) => selectedIds.includes(d.id)),
    [devices, selectedIds]
  );

  // Filtered and sorted devices
  const filteredDevices = useMemo(() => {
    let list = [...devices];

    // Status filter
    if (statusFilter !== "all") {
      list = list.filter((d) => d.status === statusFilter);
    }

    // Platform filter
    if (platformFilter !== "all") {
      list = list.filter((d) => d.platform === platformFilter);
    }

    // Group / tag filters
    if (groupFilter !== "all") {
      list = list.filter((d) => (d as unknown as { group?: string }).group === groupFilter);
    }
    if (tagFilter !== "all") {
      list = list.filter((d) => (d.tags || []).includes(tagFilter));
    }

    // Search query
    const q = searchQuery.toLowerCase().trim();
    if (q) {
      list = list.filter(
        (d) =>
          d.hostname.toLowerCase().includes(q) ||
          d.id.toLowerCase().includes(q) ||
          d.osRelease.toLowerCase().includes(q) ||
          d.arch.toLowerCase().includes(q) ||
          d.assignedModels.some((m) => m.toLowerCase().includes(q))
      );
    }

    // Sorting
    list.sort((a, b) => {
      let comparison = 0;
      if (sortField === "hostname") {
        comparison = a.hostname.localeCompare(b.hostname);
      } else if (sortField === "latency") {
        comparison = a.latencyMs - b.latencyMs;
      } else if (sortField === "heartbeat") {
        comparison = new Date(b.lastHeartbeat).getTime() - new Date(a.lastHeartbeat).getTime();
      } else if (sortField === "tokenExpiry") {
        // P1-3: expired tokens first, then expiring-soon, then valid, then
        // devices with no reported expiry; hostname breaks ties so the
        // order is stable and the at-risk devices stay visible on top.
        const rank = (d: EnrolledDevice) => {
          const s = tokenExpiryStatus(d.tokenExpiresAt);
          return s === "expired" ? 0 : s === "expiring" ? 1 : s === "valid" ? 2 : 3;
        };
        comparison = rank(a) - rank(b) || a.hostname.localeCompare(b.hostname);
        return sortOrder === "asc" ? comparison : -comparison;
      }
      return sortOrder === "asc" ? comparison : -comparison;
    });

    return list;
  }, [devices, statusFilter, platformFilter, groupFilter, tagFilter, searchQuery, sortField, sortOrder]);

  const controlUrl = apiOrigin.replace(/\/$/, "") || "http://127.0.0.1:8000";
  const hasRealToken = Boolean(enrolledToken);
  const linuxEnrollCommand = hasRealToken
    ? `curl -sSL ${controlUrl}/install.sh | bash -s -- -y --device-token=${enrolledToken} --control-url=${controlUrl}`
    : `# Generate an enrollment token first, then run:\n# curl -sSL ${controlUrl}/install.sh | bash -s -- -y --device-token=<TOKEN> --control-url=${controlUrl}`;
  const windowsEnrollCommand = hasRealToken
    ? `iwr ${controlUrl}/install.ps1 -OutFile install-ai-bridge.ps1; powershell -ExecutionPolicy Bypass -File .\\install-ai-bridge.ps1 -ControlUrl '${controlUrl}' -DeviceToken '${enrolledToken}'`
    : `# Generate an enrollment token first, then:\n# iwr ${controlUrl}/install.ps1 -OutFile install-ai-bridge.ps1; powershell -File .\\install-ai-bridge.ps1 -ControlUrl '${controlUrl}' -DeviceToken <TOKEN>`;

  // Wave 5A: the enrollment token is never rendered in plain text.
  // The token line shows a masked value (first 4 + last 4) with an
  // explicit Show/Hide toggle, and the visible install command shows
  // a <TOKEN> placeholder. The Copy button still copies the real
  // command (an explicit user action) — the *display* is what must
  // not leak the secret to shoulder-surfers, screenshots, or the DOM.
  const enrolledTokenMasked = enrolledToken.length > 8
    ? `${enrolledToken.slice(0, 4)}••••${enrolledToken.slice(-4)}`
    : "••••";
  const linuxEnrollCommandDisplay = hasRealToken
    ? linuxEnrollCommand.split(enrolledToken).join("<TOKEN>")
    : linuxEnrollCommand;
  const windowsEnrollCommandDisplay = hasRealToken
    ? windowsEnrollCommand.split(enrolledToken).join("<TOKEN>")
    : windowsEnrollCommand;

  const handleCopyEnrollCommand = useCallback(async () => {
    if (!hasRealToken) {
      setClipboardError(isLive
        ? "Generate an enrollment token before copying the install command."
        : "Connect to a control plane to issue a real device token.");
      return;
    }
    // Wave 5A: Copy is an explicit user action, so it copies the real
    // command (with the real token). The *displayed* command uses the
    // <TOKEN> placeholder variants (linuxEnrollCommandDisplay /
    // windowsEnrollCommandDisplay) and never shows the token.
    const text = enrollPlatformTab === "linux" ? linuxEnrollCommand : windowsEnrollCommand;
    setClipboardError("");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      setClipboardError("Clipboard access was denied. Select and copy the install command manually.");
    }
  }, [enrollPlatformTab, hasRealToken, isLive, linuxEnrollCommand, windowsEnrollCommand]);

  const handleEnrollDevice = useCallback(async () => {
    setEnrollError("");
    // Demo preview already shown: the primary button now closes the modal.
    if (!Boolean(token() || sessionToken()) && tokenProvisioned) {
      setTokenProvisioned(false);
      setEnrollModalOpen(false);
      return;
    }
    if (Boolean(token() || sessionToken())) {
      setIsEnrolling(true);
      try {
        const res = await api.enroll(enrollDeviceName.trim() || "edge-worker-node");
        setEnrolledToken(res?.device_token || "");
        setEnrolledDeviceId(res?.device_id || "");
        setTokenProvisioned(true);
        await refreshLive?.();
      } catch (err: any) {
        setEnrollError(err?.message || "Failed to enroll device.");
      } finally {
        setIsEnrolling(false);
      }
      return;
    }
    // Demo preview: keep the modal open on an explicit end state — no
    // token is issued, and auto-closing would read as success (UX-07).
    setTokenProvisioned(true);
  }, [enrollDeviceName, refreshLive, tokenProvisioned]);

  const handleRevokeDevice = useCallback(
    async (device: EnrolledDevice) => {
      setPendingAction({ kind: "revoke", id: device.id });
      try {
        if (Boolean(token() || sessionToken())) {
          await api.revoke(device.id);
          await refreshLive?.();
          pushNotice({ tone: "success", title: `Revoked credentials for ${device.hostname}.` });
        } else {
          pushNotice({ tone: "info", title: `Demo: simulated revocation for ${device.hostname}.` });
        }
      } catch (err: any) {
        pushNotice({ tone: "error", title: `Revoke failed for ${device.hostname}.`, message: err?.message || "Unknown error" });
      } finally {
        setPendingAction(null);
      }
    },
    [refreshLive]
  );

  const handleDeleteDevice = useCallback(
    async (device: EnrolledDevice) => {
      setPendingAction({ kind: "delete", id: device.id });
      try {
        if (Boolean(token() || sessionToken())) {
          await api.deleteDevice(device.id);
          await refreshLive?.();
          pushNotice({ tone: "success", title: `Deleted device ${device.hostname}.` });
        } else {
          pushNotice({ tone: "info", title: `Demo: simulated deletion for ${device.hostname}.` });
        }
      } catch (err: any) {
        pushNotice({ tone: "error", title: `Delete failed for ${device.hostname}.`, message: err?.message || "Unknown error" });
      } finally {
        setPendingAction(null);
      }
    },
    [refreshLive]
  );

  // P1-3: rotate a device token (admin). The old token is invalid
  // immediately; the new one is returned once and shown in the modal
  // below — never persisted anywhere.
  const handleRotateDeviceToken = useCallback(
    async (device: EnrolledDevice) => {
      setPendingAction({ kind: "rotate-token", id: device.id });
      try {
        const res = await api.rotateDeviceToken(device.id);
        setRotatedToken({ device, token: res.device_token, expiresAt: res.token_expires_at });
        setCopiedRotatedToken(false);
        await refreshLive?.();
        pushNotice({ tone: "success", title: `Rotated token for ${device.hostname}.`, message: "The new token is shown once below — copy it now." });
      } catch (err: any) {
        pushNotice({ tone: "error", title: `Token rotation failed for ${device.hostname}.`, message: err?.message || "Unknown error" });
      } finally {
        setPendingAction(null);
      }
    },
    [refreshLive]
  );

  const handleCopyRotatedToken = useCallback(async () => {
    if (!rotatedToken) return;
    try {
      await navigator.clipboard.writeText(rotatedToken.token);
      setCopiedRotatedToken(true);
      setTimeout(() => setCopiedRotatedToken(false), 2000);
    } catch {
      pushNotice({ tone: "error", title: "Clipboard access was denied.", message: "Select and copy the token manually." });
    }
  }, [rotatedToken]);

  // Bulk revoke / delete over the multi-selected devices (UX-34).
  const handleBulkAction = useCallback(
    async (kind: "revoke" | "delete", targets: EnrolledDevice[]) => {
      if (targets.length === 0) return;
      const live = Boolean(token() || sessionToken());
      setPendingAction({ kind: `bulk-${kind}`, id: "bulk" });
      let succeeded = 0;
      const failures: string[] = [];
      for (const device of targets) {
        try {
          if (live) {
            if (kind === "revoke") await api.revoke(device.id);
            else await api.deleteDevice(device.id);
          }
          succeeded += 1;
        } catch {
          failures.push(device.hostname);
        }
      }
      if (live) await refreshLive?.();
      setSelectedIds([]);
      setPendingAction(null);
      if (failures.length > 0) {
        pushNotice({
          tone: "error",
          title: `Bulk ${kind} partially failed.`,
          message: `${succeeded} succeeded; failed: ${failures.join(", ")}.`,
        });
      } else {
        pushNotice({
          tone: "success",
          title: live
            ? `Bulk ${kind} completed for ${succeeded} device${succeeded === 1 ? "" : "s"}.`
            : `Demo: simulated bulk ${kind} for ${succeeded} device${succeeded === 1 ? "" : "s"}.`,
        });
      }
    },
    [refreshLive]
  );

  // The risk tier is derived from the tool: run_shell is Tier 3
  // (elevated shell); the read-only tools are Tier 1.
  const dispatchTier = dispatchTool === "run_shell" ? "tier3_shell" : "tier1_safe";
  const dispatchTierLabel =
    dispatchTool === "run_shell" ? "Tier 3 — Elevated shell" : "Tier 1 — Safe (read-only)";

  const handleQuickDispatch = useCallback(
    async (device: EnrolledDevice) => {
      try {
        const newTask = await dispatchTask({
          deviceId: device.id,
          tool: dispatchTool,
          args: { format: "png", quality: 90 },
          riskTier: dispatchTier,
        });
        const taskId = newTask?.id || (newTask as any)?.task_id || "queued";
        pushNotice({ tone: "success", title: `Dispatched ${dispatchTool} to ${device.hostname} (#${taskId}).` });
        setDispatchModalDevice(null);
      } catch (err: any) {
        pushNotice({ tone: "error", title: `Dispatch of ${dispatchTool} to ${device.hostname} failed.`, message: err?.message || "Failed" });
      }
    },
    [dispatchTask, dispatchTool, dispatchTier]
  );

  return (
    <div className="w-full space-y-4">
      {/* Top Context & Header Ribbon */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-[var(--product-line)]">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-[var(--product-text)] mt-1">
              Devices
            </h1>
            <ProductModePill live={isLive} />
            {isLive && (
              <Freshness checkedAt={lastSyncAt} loading={syncState === "loading"} label="Updated" />
            )}
          </div>
        </div>

        <JXStack direction="row" spacing="sm" className="items-center flex-wrap">
          <MagneticButton
            variant="solid"
            tone="primary"
            className="hidden sm:inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
            onClick={() => {
              setEnrollError("");
              setEnrollModalOpen(true);
            }}
          >
            <PlusCircle className="w-3.5 h-3.5" aria-hidden="true" />
            Add device
          </MagneticButton>

          <JXButton
            variant="outlined"
            color="neutral"
            size="sm"
            onClick={() => {
              void refreshLive?.();
            }}
            startIcon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Refresh
          </JXButton>

          <JXButton
            variant="outlined"
            color="neutral"
            size="sm"
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("all");
              setPlatformFilter("all");
              setGroupFilter("all");
              setTagFilter("all");
              setSelectedIds([]);
            }}
            startIcon={<RotateCcw className="w-3.5 h-3.5" />}
          >
            Reset Filters
          </JXButton>
        </JXStack>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ProductMetricCard label="Total" value={totalCount} hint="Enrolled" onClick={() => setStatusFilter("all")} />
        <ProductMetricCard label="Online" value={onlineCount} hint="Heartbeat ok" trend={onlineCount > 0 ? "up" : "flat"} onClick={() => setStatusFilter("online")} />
        <ProductMetricCard label="Unresponsive" value={unresponsiveCount} hint="Needs check" trend={unresponsiveCount > 0 ? "down" : "flat"} onClick={() => setStatusFilter("unresponsive")} />
        <ProductMetricCard label="Offline" value={offlineCount} hint="No heartbeat" onClick={() => setStatusFilter("offline")} />
      </div>

      {isLive && getSyncState() === "error" && (
        <div role="alert" className="p-3 rounded-xl border border-rose-500/40 bg-rose-950/40 text-xs text-rose-300 flex items-center justify-between gap-3">
          <span>Could not sync devices: {syncError || "Sync with the control plane failed."}</span>
          <button type="button" onClick={() => void refreshLive?.()} className="underline">Retry</button>
        </div>
      )}

      {/* Filter Toolbar: Status Chips, Platform Segmented Controls, Search */}
      <ProductGlass className="p-4">
          <div className="space-y-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono text-[var(--product-text-tertiary)] uppercase tracking-wider shrink-0">
                  Status
                </span>
                <ProductSegmented
                  ariaLabel="Filter by status"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { id: "all", label: `All (${totalCount})` },
                    { id: "online", label: `Online (${onlineCount})` },
                    { id: "unresponsive", label: `Unresponsive (${unresponsiveCount})` },
                    { id: "offline", label: `Offline (${offlineCount})` },
                  ]}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono text-[var(--product-text-tertiary)] uppercase tracking-wider shrink-0">
                  Platform
                </span>
                <ProductSegmented
                  ariaLabel="Filter by platform"
                  value={platformFilter}
                  onChange={setPlatformFilter}
                  options={[
                    { id: "all", label: "All" },
                    { id: "windows", label: `Windows (${windowsCount})` },
                    { id: "linux", label: `Linux (${linuxCount})` },
                    { id: "darwin", label: `macOS (${macCount})` },
                  ]}
                />
              </div>

              {(deviceGroups.length > 0 || groupFilter !== "all" || deviceTags.length > 0 || tagFilter !== "all") && (
                <div className="flex flex-wrap items-center gap-2">
                  {deviceGroups.length > 0 || groupFilter !== "all" ? (
                    <>
                      <span className="text-xs font-mono text-[var(--product-text-tertiary)] uppercase tracking-wider shrink-0">
                        Group
                      </span>
                      <select
                        aria-label="Filter by group"
                        value={groupFilter}
                        onChange={(e) => setGroupFilter(e.target.value)}
                        className="bg-[var(--product-raised)] border border-[var(--product-line)] text-[var(--product-text-secondary)] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500 text-xs"
                      >
                        <option value="all">All groups</option>
                        {deviceGroups.map((group) => (
                          <option key={group} value={group}>{group}</option>
                        ))}
                      </select>
                    </>
                  ) : null}
                  {deviceTags.length > 0 || tagFilter !== "all" ? (
                    <>
                      <span className="text-xs font-mono text-[var(--product-text-tertiary)] uppercase tracking-wider shrink-0">
                        Tag
                      </span>
                      <select
                        aria-label="Filter by tag"
                        value={tagFilter}
                        onChange={(e) => setTagFilter(e.target.value)}
                        className="bg-[var(--product-raised)] border border-[var(--product-line)] text-[var(--product-text-secondary)] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500 text-xs"
                      >
                        <option value="all">All tags</option>
                        {deviceTags.map((tag) => (
                          <option key={tag} value={tag}>{tag}</option>
                        ))}
                      </select>
                    </>
                  ) : null}
                </div>
              )}
            </div>

            {/* Monospace Search and Sorting Row */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center pt-3 border-t border-[var(--product-line)]">
              <div className="md:col-span-8">
                <JXTextField
                  value={searchQuery}
                  onChange={(val) => setSearchQuery(val)}
                  placeholder="Search devices…"
                  aria-label="Search devices"
                  startIcon={<Search className="w-4 h-4 text-[var(--product-text-tertiary)]" />}
                  size="md"
                  clearable
                />
              </div>

              <div className="md:col-span-4 flex items-center gap-2 text-xs font-mono flex-wrap">
                <span className="text-[var(--product-text-tertiary)] flex-shrink-0">Sort by:</span>
                <select
                  aria-label="Sort devices by"
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as any)}
                  className="bg-[var(--product-raised)] border border-[var(--product-line)] text-[var(--product-text-secondary)] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500 flex-1 min-w-[100px]"
                >
                  <option value="hostname">Hostname</option>
                  <option value="latency">Latency</option>
                  <option value="heartbeat">Heartbeat</option>
                  <option value="tokenExpiry">Token expiry</option>
                </select>
                <JXButton
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  aria-label={`Sort order: ${sortOrder === "asc" ? "ascending" : "descending"}. Activate to reverse.`}
                  onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
                >
                  {sortOrder === "asc" ? "ASC ↑" : "DESC ↓"}
                </JXButton>
              </div>
            </div>
          </div>
      </ProductGlass>

      {/* SmartDataTable: 7 Columns Device Inventory */}
      <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)] overflow-hidden">
        <JXCardHeader
          title={`Devices (${filteredDevices.length})`}
          icon={<Server className="w-4 h-4 text-indigo-400" />}
        />
        <JXCardContent>
          <div className="space-y-2">
            {selectedIds.length > 0 && (
              <div role="status" className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)] text-xs">
                <span className="text-[var(--product-text-secondary)] font-semibold">
                  {selectedIds.length} device{selectedIds.length === 1 ? "" : "s"} selected
                </span>
                <JXButton
                  variant="soft"
                  color="warning"
                  size="sm"
                  disabled={pendingAction?.id === "bulk"}
                  loading={pendingAction?.id === "bulk" && pendingAction?.kind === "bulk-revoke"}
                  onClick={() => setBulkConfirm({ kind: "revoke", devices: selectedDevices })}
                >
                  Revoke selected
                </JXButton>
                <JXButton
                  variant="soft"
                  color="error"
                  size="sm"
                  disabled={pendingAction?.id === "bulk"}
                  loading={pendingAction?.id === "bulk" && pendingAction?.kind === "bulk-delete"}
                  onClick={() => setBulkConfirm({ kind: "delete", devices: selectedDevices })}
                >
                  Delete selected
                </JXButton>
                <JXButton
                  variant="text"
                  color="neutral"
                  size="sm"
                  onClick={() => setSelectedIds([])}
                >
                  Clear selection
                </JXButton>
              </div>
            )}
            <div ref={tableScrollRef} tabIndex={0} role="region" aria-label="Device inventory" className="overflow-x-auto scroll-shadow" data-scroll-left={scrollShadow.left} data-scroll-right={scrollShadow.right}>
              <table className="product-table-sticky-first w-full text-left border-collapse text-sm min-w-[640px]">
                <caption className="sr-only">Device inventory</caption>
                <thead>
                  <tr className="border-b border-[var(--product-line)] text-xs text-[var(--product-text-tertiary)]">
                    <th scope="col" className="py-3 px-3">
                      <input
                        type="checkbox"
                        aria-label="Select all devices"
                        checked={filteredDevices.length > 0 && filteredDevices.every((d) => selectedIds.includes(d.id))}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedIds(filteredDevices.map((d) => d.id));
                          else setSelectedIds([]);
                        }}
                      />
                    </th>
                    <th scope="col" className="py-3 px-3">Status</th>
                    <th scope="col" aria-sort={sortField === "hostname" ? (sortOrder === "asc" ? "ascending" : "descending") : "none"} className="py-3 px-3">Device</th>
                    <th scope="col" className="py-3 px-3">OS</th>
                    <th scope="col" aria-sort={sortField === "heartbeat" ? (sortOrder === "asc" ? "ascending" : "descending") : "none"} className="py-3 px-3">Last seen</th>
                    <th scope="col" className="py-3 px-3 sticky right-0 bg-[var(--product-raised)] text-right pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--product-line)]">
                  {filteredDevices.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-4">
                        <EmptyState
                          variant="card"
                          demo={!isLive}
                          title="No matching devices"
                          description="Try clearing filters, or enroll a new edge agent."
                          actionLabel="Add device"
                          onAction={() => {
                            setEnrollError("");
                            setEnrollModalOpen(true);
                          }}
                          secondaryLabel="Reset filters"
                          onSecondary={() => {
                            setSearchQuery("");
                            setStatusFilter("all");
                            setPlatformFilter("all");
                            setGroupFilter("all");
                            setTagFilter("all");
                            setSelectedIds([]);
                          }}
                        />
                      </td>
                    </tr>
                  ) : (
                    filteredDevices.map((device) => {
                      const isOnline = device.status === "online";
                      const isUnresponsive = device.status === "unresponsive";
                      const isSelected = device.id === selectedDeviceId;

                      return (
                        <tr
                          key={device.id}
                          className={`hover:bg-[var(--product-raised)]/70 transition-colors group ${
                            isSelected ? "bg-indigo-950/20" : ""
                          }`}
                        >
                          {/* Multi-select checkbox */}
                          <td className="py-3 px-3 whitespace-nowrap">
                            <input
                              type="checkbox"
                              aria-label={`Select ${device.hostname}`}
                              checked={selectedIds.includes(device.id)}
                              onChange={(e) => {
                                setSelectedIds(e.target.checked
                                  ? [...selectedIds, device.id]
                                  : selectedIds.filter((id) => id !== device.id));
                              }}
                            />
                          </td>

                          {/* 1. Status badge */}
                          <td className="py-3 px-3 whitespace-nowrap">
                            <StatusBadge
                              status={isUnresponsive ? "degraded" : device.status}
                              label={isOnline ? "Online" : isUnresponsive ? "Unresponsive" : "Offline"}
                            />
                          </td>

                          {/* 2. Device Identity & UUID & Arch */}
                          <td className="py-3 px-3">
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-[var(--product-text)]">
                                  {device.hostname}
                                </span>
                                {/* P1-3: token-expiry badge from list_devices' token_expires_at.
                                    Warning within 72 h, error once expired (see state/tokenExpiry.ts). */}
                                {(() => {
                                  const expiryStatus = tokenExpiryStatus(device.tokenExpiresAt);
                                  if (expiryStatus === "expired") return <StatusBadge status="error" label="Token expired" />;
                                  if (expiryStatus === "expiring") return <StatusBadge status="warning" label="Token expiring soon" />;
                                  return null;
                                })()}
                              </div>
                            </div>
                          </td>

                          {/* 3. Operating System with platform icon */}
                          <td className="py-3 px-3">
                            <div className="flex items-center gap-2">
                              {device.platform === "windows" ? (
                                <Monitor className="w-4 h-4 text-cyan-400 flex-shrink-0" />
                              ) : device.platform === "darwin" ? (
                                <Laptop className="w-4 h-4 text-purple-400 flex-shrink-0" />
                              ) : (
                                <Terminal className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                              )}
                              <div className="flex flex-col">
                                <span className="text-[var(--product-text-secondary)] font-medium">{device.osRelease}</span>
                              </div>
                            </div>
                          </td>

                          {/* 4. Cadence / Latency */}
                          <td className="py-3 px-3">
                            <span className="text-xs tabular-nums text-[var(--product-text-tertiary)]">{formatDate(new Date(device.lastHeartbeat), { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</span>
                          </td>

                          {/* 7. Sticky Actions (Right) */}
                          <td className="py-3 px-3 sticky right-0 bg-[var(--product-surface)] group-hover:bg-[var(--product-raised)]/70 transition-colors text-right pr-4">
                            <div className="flex items-center justify-end gap-1.5 sm:gap-2">
                              <JXButton
                                variant="text"
                                color="neutral"
                                size="sm"
                                onClick={() => {
                                  setSelectedDeviceId(device.id);
                                  setCurrentView("device-360-system");
                                }}
                                endIcon={<ArrowRight className="w-3 h-3 sm:w-4 sm:h-4" />}
                                className="text-xs sm:text-sm hidden sm:inline-flex"
                              >
                                Details
                              </JXButton>
                              <JXButton
                                variant="text"
                                color="neutral"
                                size="sm"
                                onClick={() => {
                                  setSelectedDeviceId(device.id);
                                  setCurrentView("device-360-system");
                                }}
                                aria-label={`Details for ${device.hostname}`}
                                className="sm:hidden p-2"
                              >
                                <ArrowRight className="w-4 h-4" />
                              </JXButton>

                              <JXButton
                                variant="soft"
                                color="neutral"
                                size="sm"
                                onClick={() => setDispatchModalDevice(device)}
                                startIcon={<Play className="w-3 h-3 sm:w-4 sm:h-4 text-emerald-400" />}
                                className="text-[11px] sm:text-xs bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)] hidden sm:inline-flex"
                              >
                                Run task
                              </JXButton>
                              <JXButton
                                variant="soft"
                                color="neutral"
                                size="sm"
                                onClick={() => setDispatchModalDevice(device)}
                                aria-label={`Run task on ${device.hostname}`}
                                className="sm:hidden p-2 bg-[var(--product-raised)] hover:bg-[var(--product-raised)]"
                              >
                                <Play className="w-4 h-4 text-emerald-400" />
                              </JXButton>

                              <JXButton
                                variant="soft"
                                color="warning"
                                size="sm"
                                disabled={pendingAction?.id === device.id}
                                loading={pendingAction?.id === device.id && pendingAction?.kind === "revoke"}
                                onClick={() => setConfirmAction({ kind: "revoke", device })}
                                startIcon={<Ban className="w-3 h-3 sm:w-4 sm:h-4" />}
                                className="text-[11px] sm:text-xs hidden sm:inline-flex"
                              >
                                Revoke
                              </JXButton>
                              <JXButton
                                variant="soft"
                                color="warning"
                                size="sm"
                                disabled={pendingAction?.id === device.id}
                                onClick={() => setConfirmAction({ kind: "revoke", device })}
                                aria-label={`Revoke credentials for ${device.hostname}`}
                                className="sm:hidden p-2"
                              >
                                <Ban className="w-4 h-4" />
                              </JXButton>

                              {/* P1-3: rotate the device token (admin endpoint; live only).
                                  Non-admin callers never see the button (fail-closed on me()). */}
                              {isLive && isAdmin && (
                                <>
                                  <JXButton
                                    variant="soft"
                                    color="neutral"
                                    size="sm"
                                    disabled={pendingAction?.id === device.id}
                                    loading={pendingAction?.id === device.id && pendingAction?.kind === "rotate-token"}
                                    onClick={() => setRotateConfirm(device)}
                                    startIcon={<KeyRound className="w-3 h-3 sm:w-4 sm:h-4" />}
                                    className="text-[11px] sm:text-xs hidden sm:inline-flex"
                                  >
                                    Rotate token
                                  </JXButton>
                                  <JXButton
                                    variant="soft"
                                    color="neutral"
                                    size="sm"
                                    disabled={pendingAction?.id === device.id}
                                    onClick={() => setRotateConfirm(device)}
                                    aria-label={`Rotate token for ${device.hostname}`}
                                    className="sm:hidden p-2"
                                  >
                                    <KeyRound className="w-4 h-4" />
                                  </JXButton>
                                </>
                              )}

                              <JXButton
                                variant="soft"
                                color="error"
                                size="sm"
                                disabled={pendingAction?.id === device.id}
                                loading={pendingAction?.id === device.id && pendingAction?.kind === "delete"}
                                onClick={() => setConfirmAction({ kind: "delete", device })}
                                startIcon={<Trash2 className="w-3 h-3 sm:w-4 sm:h-4" />}
                                className="text-[11px] sm:text-xs hidden sm:inline-flex"
                              >
                                Delete
                              </JXButton>
                              <JXButton
                                variant="soft"
                                color="error"
                                size="sm"
                                disabled={pendingAction?.id === device.id}
                                onClick={() => setConfirmAction({ kind: "delete", device })}
                                aria-label={`Delete ${device.hostname}`}
                                className="sm:hidden p-2"
                              >
                                <Trash2 className="w-4 h-4" />
                              </JXButton>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </JXCardContent>
      </JXCard>

      <div className="fixed bottom-5 right-4 z-30 sm:hidden">
        <FloatingActionButton
          label="Add"
          aria-label="Add device"
          onClick={() => {
            setEnrollError("");
            setEnrollModalOpen(true);
          }}
        />
      </div>

      {/* Enroll Device Modal */}
      {enrollModalOpen && (
        <GlassModal
          open={enrollModalOpen}
          onClose={() => setEnrollModalOpen(false)}
          title={isLive ? "Enroll new device" : "Preview device enrollment"}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleEnrollDevice();
            }}
            className="space-y-4 max-w-xl w-full text-xs font-mono"
          >
            <ProductStepProgress
              steps={["Name", "Token", "Install"]}
              current={hasRealToken ? 2 : 0}
            />
            <p className="text-[var(--product-text-tertiary)] text-xs">
              {isLive
                ? `Installers are served from the control plane (${controlUrl}/install.sh). After install, open Live home and wait for the first heartbeat.`
                : "Demo preview only — no real device token is issued. Connect a control plane to enroll."}
            </p>
            {hasRealToken && (
              <ProductNotice tone="success">
                Token ready. Copy the install command, run it on the device, then watch Live home for the first heartbeat.
              </ProductNotice>
            )}
            {!isLive && tokenProvisioned && (
              <ProductNotice tone="info">
                This was a preview — no token was issued.
              </ProductNotice>
            )}
            {clipboardError && <p role="alert" className="text-rose-300">{clipboardError}</p>}
            {enrollError && <p role="alert" className="text-rose-300">{enrollError}</p>}

            {/* Device Name */}
            <div className="space-y-1">
              <label htmlFor="enroll-device-name" className="text-[var(--product-text-secondary)] font-semibold text-xs block">
                Device Name
              </label>
              <JXTextField
                id="enroll-device-name"
                value={enrollDeviceName}
                onChange={(val) => setEnrollDeviceName(val)}
                placeholder="edge-worker-node"
                size="md"
              />
            </div>

            {enrolledToken && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-1">
                <div className="text-emerald-300 font-semibold">
                  Enrolled Device ID: {enrolledDeviceId}
                </div>
                <div className="text-[var(--product-text-secondary)] break-all">
                  Device Token:{" "}
                  <span className="text-emerald-400">
                    {showEnrolledToken ? enrolledToken : enrolledTokenMasked}
                  </span>{" "}
                  <button
                    type="button"
                    onClick={() => setShowEnrolledToken((v) => !v)}
                    className="text-indigo-400 hover:text-indigo-300 underline text-xs"
                  >
                    {showEnrolledToken ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
            )}

            {/* Script Platform Tabs */}
            <div className="space-y-2 pt-2 border-t border-[var(--product-line)]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-[var(--product-text-secondary)] font-semibold text-xs">
                  Provisioning One-Liner
                </span>
                <div className="flex items-center gap-1.5 p-1 rounded-lg bg-[var(--product-raised)] border border-[var(--product-line)]">
                  <button
                    type="button"
                    onClick={() => setEnrollPlatformTab("linux")}
                    className={`px-2.5 py-1 rounded text-[11px] transition-all ${
                      enrollPlatformTab === "linux"
                        ? "bg-indigo-600 text-white font-semibold"
                        : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                    }`}
                  >
                    Linux / macOS
                  </button>
                  <button
                    type="button"
                    onClick={() => setEnrollPlatformTab("windows")}
                    className={`px-2.5 py-1 rounded text-[11px] transition-all ${
                      enrollPlatformTab === "windows"
                        ? "bg-indigo-600 text-white font-semibold"
                        : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                    }`}
                  >
                    Windows PowerShell
                  </button>
                </div>
              </div>

              {/* Command box */}
              <div className="relative p-3.5 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)]">
                <pre className="text-emerald-400 whitespace-pre-wrap break-all text-[11px] pr-20 select-all font-mono">
                  {enrollPlatformTab === "linux" ? linuxEnrollCommandDisplay : windowsEnrollCommandDisplay}
                </pre>
                <div className="absolute right-3 top-3">
                <JXButton
                  variant="contained"
                  color="primary"
                  size="sm"
                  type="button"
                  disabled={!hasRealToken}
                  onClick={handleCopyEnrollCommand}
                  startIcon={
                    copiedCode ? (
                      <Check className="w-3.5 h-3.5 text-emerald-300" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )
                  }
                  className="bg-indigo-600 hover:bg-indigo-500 text-xs"
                >
                  {copiedCode ? "Copied!" : hasRealToken ? "Copy" : "Token first"}
                </JXButton>
                </div>
              </div>
            </div>

            {/* Navigate to the newly enrolled device (UX-07/UX-39) */}
            {enrolledDeviceId && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--product-line)]">
                <JXButton
                  variant="outlined"
                  color="primary"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setSelectedDeviceId(enrolledDeviceId);
                    setEnrollModalOpen(false);
                    setCurrentView("device-360-system");
                  }}
                >
                  Open device
                </JXButton>
                <JXButton
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setEnrollModalOpen(false);
                    setCurrentView("live");
                  }}
                >
                  Go to Live home
                </JXButton>
              </div>
            )}

            {/* Modal Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-[var(--product-line)]">
              <span className="text-[11px] text-[var(--product-text-tertiary)]">
                {enrolledToken
                  ? `Token issued for ${enrolledDeviceId}`
                  : isLive
                  ? "Live control plane enrollment"
                  : "Preview only · no key is issued"}
              </span>
              <div className="flex items-center gap-2">
                <JXButton
                  variant="soft"
                  color="neutral"
                  size="sm"
                  type="button"
                  onClick={() => setEnrollModalOpen(false)}
                >
                  {enrolledToken ? "Close" : "Cancel"}
                </JXButton>
                <JXButton
                  variant="contained"
                  color="primary"
                  size="sm"
                  type="submit"
                  loading={isEnrolling}
                  className="bg-indigo-600 hover:bg-indigo-500"
                >
                  {isLive
                    ? enrolledToken
                      ? "Issue another token"
                      : "Generate enrollment token"
                    : tokenProvisioned
                    ? "Preview complete"
                    : "Simulate key generation"}
                </JXButton>
              </div>
            </div>
          </form>
        </GlassModal>
      )}

      {/* Quick Dispatch Tool Modal */}
      {/* P1-3: rotate-token confirmation (hold-to-confirm: the old token dies immediately). */}
      <ConfirmDestructive
        open={rotateConfirm !== null}
        title="Rotate device token"
        objectName={rotateConfirm ? `${rotateConfirm.hostname} (${rotateConfirm.id})` : undefined}
        consequence="Rotate: invalidates the device's current token immediately. The device must be given the new token to reconnect, and the new token is shown only once."
        confirmLabel="Rotate token"
        requireHold
        tone="warning"
        onConfirm={() => {
          const device = rotateConfirm;
          setRotateConfirm(null);
          if (device) void handleRotateDeviceToken(device);
        }}
        onCancel={() => setRotateConfirm(null)}
      />
      {/* P1-3: new token, shown exactly once. Dismissing clears it from
          component state; it is never persisted (no store, no storage, no URL). */}
      {rotatedToken && (
        <GlassModal
          open={Boolean(rotatedToken)}
          onClose={() => { setRotatedToken(null); setCopiedRotatedToken(false); }}
          title={`New token for ${rotatedToken.device.hostname}`}
        >
          <div className="space-y-4 max-w-md w-full text-xs">
            <p className="text-amber-300">
              Shown once — copy it now. It will not be shown again, and the old token no longer works.
            </p>
            <div className="space-y-1">
              <label htmlFor="rotated-device-token" className="text-[var(--product-text-secondary)] font-semibold block">
                Device token
              </label>
              <input
                id="rotated-device-token"
                readOnly
                value={rotatedToken.token}
                autoComplete="off"
                className="w-full bg-[var(--product-raised)] border border-[var(--product-line)] text-[var(--product-text-secondary)] rounded-xl px-3 py-2 font-mono break-all"
              />
            </div>
            <p className="text-[var(--product-text-secondary)]">
              Expires {formatDate(new Date(rotatedToken.expiresAt * 1000), { dateStyle: "medium", timeStyle: "short" })}.
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[var(--product-line)]">
              <JXButton
                variant="soft"
                color="neutral"
                size="sm"
                type="button"
                onClick={handleCopyRotatedToken}
                startIcon={copiedRotatedToken ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
              >
                {copiedRotatedToken ? "Copied!" : "Copy token"}
              </JXButton>
              <JXButton
                variant="contained"
                color="primary"
                size="sm"
                type="button"
                onClick={() => { setRotatedToken(null); setCopiedRotatedToken(false); }}
                className="bg-indigo-600 hover:bg-indigo-500"
              >
                Done — I copied it
              </JXButton>
            </div>
          </div>
        </GlassModal>
      )}
      {dispatchModalDevice && (
        <GlassModal
          open={Boolean(dispatchModalDevice)}
          onClose={() => setDispatchModalDevice(null)}
          title={`Dispatch Tool: ${dispatchModalDevice.hostname}`}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setDispatchConfirm(true);
            }}
            className="space-y-4 max-w-md w-full text-xs font-mono"
          >
            <p className="text-[var(--product-text-tertiary)]">
              Dispatch a remote diagnostic or automation tool on device {dispatchModalDevice.id}.
            </p>

            <div className="space-y-1">
              <label htmlFor="dispatch-tool-select" className="text-[var(--product-text-secondary)] font-semibold">Select Tool</label>
              <select
                id="dispatch-tool-select"
                aria-label="Select dispatch tool"
                value={dispatchTool}
                onChange={(e) => setDispatchTool(e.target.value)}
                className="w-full bg-[var(--product-raised)] border border-[var(--product-line)] text-[var(--product-text-secondary)] rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-indigo-500"
              >
                <option value="capture_desktop_screenshot">capture_desktop_screenshot (read / capture)</option>
                <option value="list_processes">list_processes (read)</option>
                <option value="get_system_info">get_system_info (read)</option>
                <option value="list_desktop_windows">list_desktop_windows (desktop)</option>
                <option value="get_desktop_status">get_desktop_status (desktop honesty)</option>
                <option value="run_shell">run_shell (Tier 3 — Elevated shell, requires approval)</option>
              </select>
            </div>

            <p className="text-[var(--product-text-secondary)]">
              Tier: {dispatchTierLabel}
              {dispatchTool === "run_shell"
                ? " — dispatch requires approval and hold-to-confirm."
                : ""}
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--product-line)]">
              <JXButton
                variant="soft"
                color="neutral"
                size="sm"
                type="button"
                onClick={() => setDispatchModalDevice(null)}
              >
                Cancel
              </JXButton>
              <JXButton
                variant="contained"
                color="primary"
                size="sm"
                type="submit"
                className="bg-indigo-600 hover:bg-indigo-500"
              >
                Dispatch
              </JXButton>
            </div>
          </form>
        </GlassModal>
      )}

      {/* Destructive-action confirmations (UX-03) */}
      <ConfirmDestructive
        open={confirmAction !== null}
        title={confirmAction?.kind === "revoke" ? "Revoke device credentials" : "Delete device"}
        objectName={confirmAction ? `${confirmAction.device.hostname} (${confirmAction.device.id})` : undefined}
        consequence={
          confirmAction?.kind === "revoke"
            ? "Revoke: invalidates the device's credentials; the device can re-enroll."
            : "Delete: removes the device record."
        }
        confirmLabel={confirmAction?.kind === "revoke" ? "Revoke credentials" : "Delete device"}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (action) {
            void (action.kind === "revoke" ? handleRevokeDevice(action.device) : handleDeleteDevice(action.device));
          }
        }}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDestructive
        open={bulkConfirm !== null}
        title={bulkConfirm?.kind === "revoke" ? "Revoke credentials for selected devices" : "Delete selected devices"}
        objectName={bulkConfirm ? bulkConfirm.devices.map((d) => d.hostname).join(", ") : undefined}
        consequence={
          bulkConfirm?.kind === "revoke"
            ? `Revoke: invalidates the credentials of ${bulkConfirm?.devices.length ?? 0} device(s); each device can re-enroll.`
            : `Delete: removes the records of ${bulkConfirm?.devices.length ?? 0} device(s).`
        }
        confirmLabel={bulkConfirm?.kind === "revoke" ? "Revoke selected" : "Delete selected"}
        onConfirm={() => {
          const bulk = bulkConfirm;
          setBulkConfirm(null);
          if (bulk) void handleBulkAction(bulk.kind, bulk.devices);
        }}
        onCancel={() => setBulkConfirm(null)}
      />
      {dispatchModalDevice && (
        <ConfirmDestructive
          open={dispatchConfirm}
          title="Dispatch tool"
          objectName={`${dispatchTool} (${dispatchTierLabel}) on ${dispatchModalDevice.hostname} (${dispatchModalDevice.id})`}
          consequence={
            dispatchTool === "run_shell"
              ? "This dispatches an elevated shell task (Tier 3) on the device. It runs with elevated privileges and requires approval."
              : `This dispatches ${dispatchTool} on the device.`
          }
          confirmLabel="Dispatch"
          requireHold={dispatchTool === "run_shell"}
          tone="warning"
          onConfirm={() => {
            setDispatchConfirm(false);
            void handleQuickDispatch(dispatchModalDevice);
          }}
          onCancel={() => setDispatchConfirm(false)}
        />
      )}
    </div>
  );
};

export default DevicesView;
