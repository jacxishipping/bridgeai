/**
 * AI Bridge Enterprise Dashboard — Device360View (Screen 3)
 * Device 360 System Dashboard & Hardware Gauges:
 * Device Selector Dropdown, 4 Hardware Telemetry Gauges (CPU Cores, RAM, Disk, Net),
 * 4 JXTabs Panels (Processes with kill guard, Installed Apps, Network Sockets, Daemons),
 * Security Fingerprint Drawer, Fast Action Command Ribbon with Hold-to-Confirm Reboot.
 * Pure @jacxishippingorg/jx-ui-react, motion/react, and lucide-react. ZERO inline styles.
 */

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { motion } from "motion/react";
import { api, apiOrigin, sessionToken, token } from "../api";
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
  JXLinearProgress,
  JXAlert,
  JXSelect,
  GlassModal,
  HoldToConfirmButton,
  BreadcrumbTrail,
  ProductToolbar,
  StatusBadge,
  ConfirmDestructive,
  EmptyState,
} from "../ui";
import { Freshness } from "../components/Freshness";
import { pushNotice } from "../state/notices";
import { tokenExpiryStatus } from "../state/tokenExpiry";
import { useLanguage } from "../i18n";
import {
  Server,
  Activity,
  Shield,
  ShieldCheck,
  Cpu,
  HardDrive,
  Layers,
  Zap,
  Terminal,
  Monitor,
  Laptop,
  Search,
  ArrowLeft,
  ArrowRight,
  Check,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  Play,
  Square,
  RotateCcw,
  RefreshCw,
  Lock,
  Radio,
  Network,
  Settings,
  Trash2,
  Flame,
  Eye,
  KeyRound,
  Copy,
} from "lucide-react";
import { useDashboardStore } from "../state/dashboardStore";
import type { EnrolledDevice } from "../types/dashboard";

interface ProcessItem {
  pid: number;
  name: string;
  user: string;
  cpuPercent: number;
  memoryMb: number;
  threads: number;
  state: "R (Running)" | "S (Sleeping)" | "D (Disk Wait)";
  isProtected?: boolean;
}

interface InstalledApp {
  id: string;
  name: string;
  version: string;
  publisher: string;
  binaryPath: string;
  category: "Runtime" | "Database" | "Container" | "Tooling" | "Browser";
}

interface SocketPort {
  port: number;
  protocol: "TCP" | "UDP";
  localAddress: string;
  foreignAddress: string;
  state: "LISTEN" | "ESTABLISHED" | "TIME_WAIT";
  service: string;
}

interface SystemDaemon {
  name: string;
  description: string;
  status: "active" | "stopped" | "failed";
  pid: number;
  memoryMb: number;
  restarts: number;
}

export const Device360View: React.FC = () => {
  const devices = useDashboardStore((s) => s.devices);
  const selectedDeviceId = useDashboardStore((s) => s.selectedDeviceId);
  const setSelectedDeviceId = useDashboardStore((s) => s.setSelectedDeviceId);
  const setCurrentView = useDashboardStore((s) => s.setCurrentView);
  const dispatchTask = useDashboardStore((s) => s.dispatchTask);
  const refreshLive = useDashboardStore((s) => s.refreshLive);
  const syncState = useDashboardStore((s) => s.syncState);
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const { t, date: formatDate } = useLanguage();
  const isLive = typeof window !== "undefined" && Boolean(token() || sessionToken());
  const controlBase = (apiOrigin || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");

  // UX-27: an unknown ?device= id must NEVER fall back to devices[0].
  // Only fall back to the first device when no device was selected at all.
  const requestedDeviceId = selectedDeviceId;
  const selectedDevice = useMemo(
    () =>
      devices.find((d) => d.id === selectedDeviceId) ??
      (selectedDeviceId ? undefined : devices[0]),
    [devices, selectedDeviceId]
  );

  // Render unreported telemetry as an explicit greyed "— not reported"
  // cell instead of 0 / "unknown" (UX-39); "Not reported" goes through t().
  const notReported = (value: string | null | undefined) =>
    !value || value === "Not reported" || value === "unknown" ? (
      <span className="text-[var(--product-text-dim)]">— {t("Not reported")}</span>
    ) : (
      value
    );

  const telemetry = selectedDevice?.telemetry || {
    cpuPercent: 0,
    cpuCores: [0, 0, 0, 0],
    cpuClockGhz: 0,
    memoryUsedGb: 0,
    memoryTotalGb: 16,
    swapUsedGb: 0,
    swapTotalGb: 0,
    diskUsedGb: 0,
    diskTotalGb: 500,
    diskPercent: 0,
    networkRxMbps: 0,
    networkTxMbps: 0,
    ipAddress: "Not reported",
    uptimeSeconds: 0,
    tpmStatus: "offline",
    certExpiryDays: 0,
    fingerprintSha256: "unknown",
  };

  const isOffline = !selectedDevice || selectedDevice.status === "offline";

  // Active diagnostic panel tab
  const [activeTab, setActiveTab] = useState<string>("processes");

  // Fast command ribbon feedback
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const handleCopyCommand = useCallback((cmd: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedCommand(cmd);
    setTimeout(() => setCopiedCommand(null), 2500);
  }, []);

  // Process manager state
  const [processSearch, setProcessSearch] = useState<string>("");
  const [processSortBy, setProcessSortBy] = useState<"cpu" | "mem" | "pid" | "name">("cpu");
  const [processToKill, setProcessToKill] = useState<ProcessItem | null>(null);
  const [killGuardError, setKillGuardError] = useState<string | null>(null);

  // Live diagnostic lists (populated from /api/devices/{id}/overview)
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [listeningSockets, setListeningSockets] = useState<SocketPort[]>([]);
  const [daemons, setDaemons] = useState<SystemDaemon[]>([]);
  const [loadingOverview, setLoadingOverview] = useState<boolean>(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewRetry, setOverviewRetry] = useState<number>(0);
  const [telemetryHistoryCount, setTelemetryHistoryCount] = useState<number>(0);

  // P1-3: the overview response carries the full device row under
  // `device` (SELECT *), so `device.mtls_fingerprint` is the REAL
  // mTLS fingerprint — unlike the seeded telemetry.fingerprintSha256
  // below, which is demo data and must never be shown as the fingerprint.
  const [overviewDevice, setOverviewDevice] = useState<{
    mtls_fingerprint?: string | null;
    token_expires_at?: number | null;
  } | null>(null);
  // P1-3: admin-only controls (rotate token, set/clear fingerprint) are
  // gated on api.me() reporting role "admin"; fail-closed (false) when
  // me() fails. The server still enforces admin on every call.
  const [isAdmin, setIsAdmin] = useState(false);
  // P1-3: rotated token, shown once and held only in component state.
  const [rotateConfirm, setRotateConfirm] = useState(false);
  const [rotatedToken, setRotatedToken] = useState<{ token: string; expiresAt: number } | null>(null);
  const [copiedRotatedToken, setCopiedRotatedToken] = useState(false);
  const [rotatePending, setRotatePending] = useState(false);
  // P1-3: mTLS fingerprint editing (admin only). The backend normalizes
  // hex with optional colons/spaces; the raw input is sent as typed.
  const [fingerprintDraft, setFingerprintDraft] = useState("");
  const [fingerprintSaving, setFingerprintSaving] = useState(false);
  const [clearFingerprintConfirm, setClearFingerprintConfirm] = useState(false);

  useEffect(() => {
    let active = true;
    if (!isLive) { setIsAdmin(false); return; }
    api.me()
      .then((me: any) => { if (active) setIsAdmin(me?.role === "admin"); })
      .catch(() => { if (active) setIsAdmin(false); });
    return () => { active = false; };
  }, [isLive]);

  useEffect(() => {
    let active = true;
    if (!selectedDevice?.id) return;
    if (isOffline) {
      setProcesses([]);
      setInstalledApps([]);
      setListeningSockets([]);
      setDaemons([]);
      setTelemetryHistoryCount(0);
      setOverviewDevice(null);
      return;
    }
    setLoadingOverview(true);
    setOverviewError(null);
    if (isLive) {
      api.deviceTelemetry(selectedDevice.id, 20)
        .then((hist: any) => {
          if (!active) return;
          const samples = Array.isArray(hist?.samples) ? hist.samples : Array.isArray(hist) ? hist : [];
          setTelemetryHistoryCount(samples.length);
        })
        .catch(() => {});
    }
    api.deviceOverview(selectedDevice.id)
      .then((data: any) => {
        if (!active) return;
        // P1-3: keep the device row (mtls_fingerprint, token_expires_at)
        // for the Security Fingerprint card. Also prefill the fingerprint
        // editor with the current value for editing.
        const row = data?.device && typeof data.device === "object" ? data.device : null;
        setOverviewDevice(row ? {
          mtls_fingerprint: typeof row.mtls_fingerprint === "string" ? row.mtls_fingerprint : null,
          token_expires_at: typeof row.token_expires_at === "number" ? row.token_expires_at : null,
        } : null);
        if (typeof row?.mtls_fingerprint === "string") setFingerprintDraft(row.mtls_fingerprint);
        if (Array.isArray(data?.processes)) {
          setProcesses(
            data.processes.map((p: any) => ({
              pid: p.pid || 1,
              name: p.name || p.cmd || "process",
              user: p.user || p.username || "system",
              cpuPercent: typeof p.cpu_percent === "number" ? p.cpu_percent : 0,
              memoryMb:
                typeof p.memory_mb === "number"
                  ? Math.round(p.memory_mb)
                  : typeof p.memory_percent === "number"
                  ? Math.round(p.memory_percent * 160)
                  : 0,
              threads: p.threads || 1,
              state: p.state || "R (Running)",
              isProtected: p.pid === 1 || p.name === "ai-bridge-agent" || p.name === "sshd",
            }))
          );
        } else {
          setProcesses([]);
        }
        if (Array.isArray(data?.apps?.installed_packages)) {
          setInstalledApps(
            data.apps.installed_packages.map((pkg: any, idx: number) => ({
              id: `app-${idx}`,
              name: typeof pkg === "string" ? pkg : pkg.name || "package",
              version: pkg.version || "installed",
              publisher:
                pkg.publisher ||
                (selectedDevice.platform === "windows" ? "Microsoft / Vendor" : "Ubuntu / Debian"),
              binaryPath:
                pkg.path || (selectedDevice.platform === "windows" ? "C:\\Program Files" : "/usr/bin"),
              category: "Tooling",
            }))
          );
        } else {
          setInstalledApps([]);
        }
        if (Array.isArray(data?.network?.sockets)) {
          setListeningSockets(
            data.network.sockets.map((s: any) => ({
              port: s.port || 0,
              protocol: s.protocol || "TCP",
              localAddress: s.local || `0.0.0.0:${s.port || 0}`,
              foreignAddress: s.foreign || "*:*",
              state: s.state || "LISTEN",
              service: s.service || `Port ${s.port}`,
            }))
          );
        } else {
          setListeningSockets([]);
        }
        if (data?.apps?.service_statuses && typeof data.apps.service_statuses === "object") {
          const list: SystemDaemon[] = Object.entries(data.apps.service_statuses).map(
            ([name, status]) => ({
              name: `${name}.service`,
              description: `System service ${name}`,
              status: (status === "running" || status === "active"
                ? "active"
                : "stopped") as "active" | "stopped" | "failed",
              pid: status === "running" ? 1000 : 0,
              memoryMb: status === "running" ? 48 : 0,
              restarts: 0,
            })
          );
          setDaemons(list);
        } else {
          setDaemons([]);
        }
      })
      .catch(() => {
        if (!active) return;
        setOverviewError("Device diagnostics could not be loaded.");
        setOverviewDevice(null);
        setProcesses([]);
        setInstalledApps([]);
        setListeningSockets([]);
        setDaemons([]);
      })
      .finally(() => {
        if (active) setLoadingOverview(false);
      });
    return () => {
      active = false;
    };
  }, [selectedDevice?.id, isOffline, overviewRetry]);

  // Options for device selector dropdown
  const deviceOptions = useMemo(
    () =>
      devices.map((d) => ({
        id: d.id,
        label: `${d.hostname} (${d.name})`,
        meta: `${d.osRelease} • ${d.platform}`,
        status: (d.status === "online"
          ? "Healthy"
          : d.status === "unresponsive"
          ? "Degraded"
          : "Offline") as "Healthy" | "Degraded" | "Offline",
      })),
    [devices]
  );

  // Fast action command handlers
  const handleCaptureScreen = useCallback(async () => {
    if (!selectedDevice) return;
    setActionFeedback(null);
    try {
      const task = await dispatchTask({
        deviceId: selectedDevice.id,
        tool: "desktop_get_screenshot",
        args: { format: "png", quality: 90 },
        riskTier: "tier1_safe",
      });
      setActionFeedback(`Screen captured for ${selectedDevice.hostname} (#${task.id}).`);
    } catch (err: any) {
      setActionFeedback(`Capture failed: ${err?.message}`);
    }
  }, [dispatchTask, selectedDevice]);

  const handleFlushDns = useCallback(async () => {
    if (!selectedDevice) return;
    setActionFeedback(null);
    const cmd = selectedDevice.platform === "windows" ? "ipconfig /flushdns" : "systemd-resolve --flush-caches";
    try {
      const task = await dispatchTask({
        deviceId: selectedDevice.id,
        tool: "run_shell",
        args: { command: cmd },
        riskTier: "tier3_shell",
      });
      setActionFeedback(`DNS cache flush dispatched to ${selectedDevice.hostname} (#${task.id}).`);
    } catch (err: any) {
      setActionFeedback(`Flush failed: ${err?.message}`);
    }
  }, [dispatchTask, selectedDevice]);

  const handleCreateBackup = useCallback(async () => {
    if (!selectedDevice) return;
    setActionFeedback(null);
    const cmd =
      selectedDevice.platform === "windows"
        ? "powershell -NoProfile -Command \"Compress-Archive -Path C:\\ai-bridge\\workspace -DestinationPath C:\\ai-bridge\\snapshot.zip -Force\""
        : "tar -czf /opt/backups/snapshot.tar.gz /opt/ai-bridge/workspace";
    try {
      const task = await dispatchTask({
        deviceId: selectedDevice.id,
        tool: "run_shell",
        args: { command: cmd },
        riskTier: "tier2_workspace",
      });
      setActionFeedback(`Backup archive snapshot initiated (#${task.id}).`);
    } catch (err: any) {
      setActionFeedback(`Backup failed: ${err?.message}`);
    }
  }, [dispatchTask, selectedDevice]);

  const handleRebootNode = useCallback(async () => {
    if (!selectedDevice) return;
    setActionFeedback(null);
    const cmd = selectedDevice.platform === "windows" ? "shutdown /r /t 5" : "systemctl reboot";
    try {
      const task = await dispatchTask({
        deviceId: selectedDevice.id,
        tool: "run_shell",
        args: { command: cmd },
        riskTier: "tier4_kernel",
      });
      setActionFeedback(`SIGREBOOT issued for ${selectedDevice.hostname} (#${task.id}).`);
    } catch (err: any) {
      setActionFeedback(`Reboot failed: ${err?.message}`);
    }
  }, [dispatchTask, selectedDevice]);

  const handleRefreshTelemetry = useCallback(async () => {
    if (!selectedDevice) return;
    setActionFeedback(null);
    if (!isLive) {
      setActionFeedback(`Telemetry refreshed for ${selectedDevice.hostname} (demo snapshot).`);
      return;
    }
    try {
      await api.refreshDeviceTelemetry(selectedDevice.id);
      await refreshLive?.();
      setActionFeedback(`Live telemetry refresh queued for ${selectedDevice.hostname}.`);
    } catch (err: any) {
      setActionFeedback(`Telemetry refresh failed: ${err?.message}`);
    }
  }, [isLive, refreshLive, selectedDevice]);

  const handleUpdateAgent = useCallback(async () => {
    if (!selectedDevice) return;
    setActionFeedback(null);
    if (!isLive) {
      setActionFeedback(`Demo agent upgrade simulated for ${selectedDevice.hostname}.`);
      return;
    }
    try {
      const res = await api.updateDeviceAgent(selectedDevice.id);
      setActionFeedback(`Agent update dispatched for ${selectedDevice.hostname} (${res?.task_id || "queued"}).`);
    } catch (err: any) {
      setActionFeedback(`Agent update failed: ${err?.message}`);
    }
  }, [isLive, selectedDevice]);

  const handleSyncDeviceMetadata = useCallback(async () => {
    if (!selectedDevice) return;
    setActionFeedback(null);
    if (!isLive) {
      setActionFeedback(`Metadata synchronized locally for ${selectedDevice.hostname}.`);
      return;
    }
    try {
      await api.updateDevice(selectedDevice.id, {
        name: selectedDevice.name,
        hostname: selectedDevice.hostname,
        os: selectedDevice.osRelease,
      });
      await refreshLive?.();
      setActionFeedback(`Synchronized control-plane record for ${selectedDevice.hostname}.`);
    } catch (err: any) {
      setActionFeedback(`Device update failed: ${err?.message}`);
    }
  }, [isLive, refreshLive, selectedDevice]);

  // P1-3: rotate the device token (admin). The old token dies
  // immediately; the new one is shown once in the modal below and never
  // persisted anywhere.
  const handleRotateDeviceToken = useCallback(async () => {
    if (!selectedDevice) return;
    setRotatePending(true);
    try {
      const res = await api.rotateDeviceToken(selectedDevice.id);
      setRotatedToken({ token: res.device_token, expiresAt: res.token_expires_at });
      setCopiedRotatedToken(false);
      await refreshLive?.();
      pushNotice({ tone: "success", title: `Rotated token for ${selectedDevice.hostname}.`, message: "The new token is shown once below — copy it now." });
    } catch (err: any) {
      pushNotice({ tone: "error", title: `Token rotation failed for ${selectedDevice.hostname}.`, message: err?.message || "Unknown error" });
    } finally {
      setRotatePending(false);
    }
  }, [refreshLive, selectedDevice]);

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

  // P1-3: set the mTLS fingerprint (admin). Hex with optional colons /
  // spaces is accepted — the backend normalizes it. An empty input is
  // NOT sent here; clearing goes through the confirm dialog below, which
  // sends the contract's explicit empty fingerprint.
  const handleSaveFingerprint = useCallback(async () => {
    if (!selectedDevice) return;
    const value = fingerprintDraft.trim();
    if (!value) {
      pushNotice({ tone: "warning", title: "Enter a fingerprint to save.", message: "To remove the fingerprint, use Clear fingerprint." });
      return;
    }
    setFingerprintSaving(true);
    try {
      const res = await api.setDeviceMtlsFingerprint(selectedDevice.id, value);
      setOverviewDevice((prev) => ({ ...(prev ?? {}), mtls_fingerprint: res.mtls_fingerprint }));
      setFingerprintDraft(res.mtls_fingerprint ?? "");
      pushNotice({ tone: "success", title: `mTLS fingerprint set for ${selectedDevice.hostname}.` });
    } catch (err: any) {
      pushNotice({ tone: "error", title: `Setting the fingerprint failed for ${selectedDevice.hostname}.`, message: err?.message || "Unknown error" });
    } finally {
      setFingerprintSaving(false);
    }
  }, [fingerprintDraft, selectedDevice]);

  // P1-3: clear the mTLS fingerprint (admin). Per the API contract an
  // explicitly empty fingerprint clears it and returns mtls_fingerprint null.
  const handleClearFingerprint = useCallback(async () => {
    if (!selectedDevice) return;
    setFingerprintSaving(true);
    try {
      const res = await api.setDeviceMtlsFingerprint(selectedDevice.id, "");
      setOverviewDevice((prev) => ({ ...(prev ?? {}), mtls_fingerprint: res.mtls_fingerprint ?? null }));
      setFingerprintDraft("");
      pushNotice({ tone: "success", title: `mTLS fingerprint cleared for ${selectedDevice.hostname}.` });
    } catch (err: any) {
      pushNotice({ tone: "error", title: `Clearing the fingerprint failed for ${selectedDevice.hostname}.`, message: err?.message || "Unknown error" });
    } finally {
      setFingerprintSaving(false);
    }
  }, [selectedDevice]);

  // Filtered and sorted processes
  const filteredProcesses = useMemo(() => {
    let list = processes.filter(
      (p) =>
        p.name.toLowerCase().includes(processSearch.toLowerCase()) ||
        p.user.toLowerCase().includes(processSearch.toLowerCase()) ||
        String(p.pid).includes(processSearch)
    );

    list.sort((a, b) => {
      if (processSortBy === "cpu") return b.cpuPercent - a.cpuPercent;
      if (processSortBy === "mem") return b.memoryMb - a.memoryMb;
      if (processSortBy === "pid") return a.pid - b.pid;
      return a.name.localeCompare(b.name);
    });

    return list;
  }, [processes, processSearch, processSortBy]);

  // Process termination handler with protection guard
  const handleConfirmKillProcess = useCallback(async () => {
    if (!processToKill) return;

    if (processToKill.isProtected || processToKill.pid === 1 || processToKill.name === "ai-bridge-agent") {
      setKillGuardError(
        `Protected System Process: Cannot terminate "${processToKill.name}" (PID ${processToKill.pid}) without compromising the control plane.`
      );
      return;
    }

    if (isLive && selectedDevice) {
      try {
        const cmd =
          selectedDevice.platform === "windows"
            ? `taskkill /PID ${processToKill.pid} /F`
            : `kill -15 ${processToKill.pid}`;
        const task = await dispatchTask({
          deviceId: selectedDevice.id,
          tool: "run_shell",
          args: { command: cmd },
          riskTier: "tier3_shell",
        });
        setActionFeedback(`Kill requested for PID ${processToKill.pid} (${processToKill.name}) (#${task.id}) — confirm in Processes.`);
      } catch (err: any) {
        setKillGuardError(`Failed to dispatch kill task: ${err?.message || "Unknown error"}`);
        return;
      }
    } else {
      setActionFeedback(`Kill requested for PID ${processToKill.pid} (${processToKill.name}) — confirm in Processes.`);
    }

    // UX-39: keep the process row until telemetry refresh confirms the PID
    // is gone; the feedback above is labelled "requested", not "done".
    setProcessToKill(null);
    setKillGuardError(null);
  }, [dispatchTask, isLive, processToKill, selectedDevice]);

  // Daemon state toggle handler (stop goes through ConfirmDestructive, UX-03)
  const [daemonConfirm, setDaemonConfirm] = useState<{ name: string; action: "stop" } | null>(null);
  const [daemonPending, setDaemonPending] = useState<string | null>(null);
  const handleDaemonAction = useCallback(async (daemonName: string, action: "start" | "stop" | "restart") => {
    setDaemonPending(daemonName);
    try {
    if (isLive && selectedDevice) {
      const svc = daemonName.replace(/\.service$/, "");
      const cmd =
        selectedDevice.platform === "windows"
          ? action === "restart"
            ? `sc stop "${svc}" && sc start "${svc}"`
            : `sc ${action} "${svc}"`
          : `systemctl ${action} ${daemonName}`;
      try {
        const task = await dispatchTask({
          deviceId: selectedDevice.id,
          tool: "run_shell",
          args: { command: cmd },
          riskTier: "tier3_shell",
        });
        void api.refreshDeviceTelemetry(selectedDevice.id).catch(() => {});
        setActionFeedback(`Daemon ${daemonName}: ${action.toUpperCase()} dispatched (#${task.id}).`);
        return;
      } catch (err: any) {
        setActionFeedback(`Daemon ${daemonName} ${action} failed: ${err?.message || "Unknown error"}`);
        return;
      }
    }
    const deterministicPid = 1000 + ((daemonName.length * 137 + action.length * 41) % 8000);
    setDaemons((prev) =>
      prev.map((d) => {
        if (d.name !== daemonName) return d;
        if (action === "stop") {
          return { ...d, status: "stopped", pid: 0 };
        }
        if (action === "start") {
          return { ...d, status: "active", pid: deterministicPid };
        }
        return {
          ...d,
          status: "active",
          pid: deterministicPid,
          restarts: d.restarts + 1,
        };
      })
    );
    setActionFeedback(`Daemon ${daemonName}: ${action.toUpperCase()} simulated in demo mode.`);
    } finally {
      setDaemonPending(null);
    }
  }, [dispatchTask, isLive, selectedDevice]);

  // UX-27: a requested device id that matches nothing renders an explicit
  // "Device not available" state — never the first fleet device.
  if (!selectedDevice && requestedDeviceId && devices.length > 0) {
    return (
      <div className="w-full space-y-4">
        <div className="flex flex-wrap items-center gap-3 pb-2 border-b border-[var(--product-line)]">
          <JXButton variant="text" color="neutral" size="sm" onClick={() => setCurrentView("devices")} startIcon={<ArrowLeft className="w-4 h-4" />}>
            Back to Devices
          </JXButton>
          <BreadcrumbTrail crumbs={["Devices", "Unknown device"]} />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--product-text)] mt-1">
            Device details
          </h1>
        </div>
        <EmptyState
          variant="card"
          demo={!isLive}
          title="Device not available"
          description={`No enrolled device matches the requested id "${requestedDeviceId}". It may have been deleted, or the link may be stale.`}
          actionLabel="View fleet inventory"
          onAction={() => setCurrentView("devices")}
        />
      </div>
    );
  }

  // Empty inventory: selectedDevice is undefined when devices is empty.
  // Guard here (after all hooks) so the render below never dereferences
  // selectedDevice.hostname / .platform / .status on undefined.
  if (!selectedDevice) {
    return (
      <div className="w-full space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-[var(--product-line)]">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-[var(--product-text)] mt-1">
              Device details
            </h1>
          </div>
        </div>
        <EmptyState
          variant="card"
          demo={!isLive}
          title="No device available"
          description="The fleet inventory is empty, so there is no device to inspect. Enroll a device to see its telemetry here."
          actionLabel="View fleet inventory"
          onAction={() => setCurrentView("devices")}
        />
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      {/* Breadcrumb Navigation & Device Selector Ribbon */}
      <div className="flex flex-col gap-2 pb-2 border-b border-[var(--product-line)]">
        <div className="flex flex-wrap items-center gap-3">
          <JXButton
            variant="text"
            color="neutral"
            size="sm"
            onClick={() => setCurrentView("devices")}
            startIcon={<ArrowLeft className="w-4 h-4" />}
          >
            Back to Devices
          </JXButton>
          <BreadcrumbTrail crumbs={["Devices", selectedDevice.hostname]} />
          {isLive && (
            <Freshness checkedAt={lastSyncAt} loading={syncState === "loading"} label="Updated" />
          )}
        </div>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-[var(--product-text)] mt-1">
              Device details
            </h1>
          </div>

          {/* Device Switcher Dropdown */}
          <div className="w-full md:w-80">
            <JXSelect
              options={deviceOptions}
              value={selectedDeviceId}
              onChange={(val) => setSelectedDeviceId(val)}
              searchable
              label="Device"
            />
          </div>
        </div>
      </div>

      {/* Device Header & Fast Hardware Controls */}
      <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)] relative overflow-hidden">
        <JXCardContent>
          <div className="space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-xl bg-indigo-950/60 border border-indigo-800/40 text-indigo-400">
                  {selectedDevice.platform === "windows" ? (
                    <Monitor className="w-6 h-6 text-cyan-400" />
                  ) : selectedDevice.platform === "darwin" ? (
                    <Laptop className="w-6 h-6 text-purple-400" />
                  ) : (
                    <Server className="w-6 h-6 text-indigo-400" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-[var(--product-text)]">{selectedDevice.hostname}</span>
                    <span className="text-[11px] font-mono px-2 py-1 rounded uppercase bg-[var(--product-raised)] text-[var(--product-text-secondary)]">
                      {selectedDevice.arch}
                    </span>
                    <StatusBadge
                      status={selectedDevice.status === "unresponsive" ? "degraded" : selectedDevice.status}
                      label={selectedDevice.status === "unresponsive" ? "Unresponsive" : selectedDevice.status === "online" ? "Online" : "Offline"}
                    />
                    {/* P1-3: token-expiry badge from list_devices' token_expires_at
                        (store-mapped). Warning within 72 h, error once expired. */}
                    {(() => {
                      const expiryStatus = tokenExpiryStatus(selectedDevice.tokenExpiresAt);
                      if (expiryStatus === "expired") return <StatusBadge status="error" label="Token expired" />;
                      if (expiryStatus === "expiring") return <StatusBadge status="warning" label="Token expiring soon" />;
                      return null;
                    })()}
                  </div>
                  <p className="text-xs text-[var(--product-text-tertiary)] font-mono mt-0.5">
                    {selectedDevice.osRelease} • IP: {isOffline ? "Not assigned" : notReported(telemetry.ipAddress)} • Latency: {isOffline ? "—" : `${selectedDevice.latencyMs}ms`}
                  </p>
                </div>
              </div>

              {/* Fast Action Command Ribbon with Hold-to-Confirm Reboot */}
              <div className="flex items-center gap-2 flex-wrap">
                <JXButton
                  variant="soft"
                  color="neutral"
                  size="sm"
                  disabled={isOffline}
                  onClick={handleCaptureScreen}
                  startIcon={<Monitor className="w-3.5 h-3.5 text-indigo-400" />}
                  className="bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)] border border-[var(--product-line)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Capture Screen
                </JXButton>

                <JXButton
                  variant="soft"
                  color="neutral"
                  size="sm"
                  disabled={isOffline}
                  onClick={handleFlushDns}
                  startIcon={<RotateCcw className="w-3.5 h-3.5 text-cyan-400" />}
                  className="bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)] border border-[var(--product-line)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Flush DNS
                </JXButton>

                <JXButton
                  variant="soft"
                  color="neutral"
                  size="sm"
                  disabled={isOffline}
                  onClick={handleCreateBackup}
                  startIcon={<HardDrive className="w-3.5 h-3.5 text-amber-400" />}
                  className="bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)] border border-[var(--product-line)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Create Backup
                </JXButton>

                {/* P1-3: rotate the device token (admin only; the old token
                    dies immediately and the new one is shown once). */}
                {isLive && isAdmin && (
                  <JXButton
                    variant="soft"
                    color="neutral"
                    size="sm"
                    disabled={isOffline || rotatePending}
                    loading={rotatePending}
                    onClick={() => setRotateConfirm(true)}
                    startIcon={<KeyRound className="w-3.5 h-3.5 text-emerald-400" />}
                    className="bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)] border border-[var(--product-line)] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Rotate token
                  </JXButton>
                )}

                <ProductToolbar>
                  <JXButton
                    variant="outlined"
                    color="neutral"
                    size="sm"
                    disabled={isOffline}
                    onClick={() => void handleRefreshTelemetry()}
                    startIcon={<RefreshCw className="w-3.5 h-3.5 text-indigo-400" />}
                  >
                    Refresh Telemetry{telemetryHistoryCount > 0 ? ` (${telemetryHistoryCount})` : ""}
                  </JXButton>
                  <JXButton
                    variant="outlined"
                    color="neutral"
                    size="sm"
                    disabled={isOffline}
                    onClick={() => void handleUpdateAgent()}
                    startIcon={<Zap className="w-3.5 h-3.5 text-emerald-400" />}
                  >
                    Update Agent
                  </JXButton>
                  <JXButton
                    variant="outlined"
                    color="neutral"
                    size="sm"
                    disabled={!selectedDevice}
                    onClick={() => void handleSyncDeviceMetadata()}
                    startIcon={<CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />}
                  >
                    Sync device record
                  </JXButton>
                </ProductToolbar>

                {/* Reboot Device Hold-to-Confirm Button */}
                {isOffline ? (
                  <JXButton
                    variant="soft"
                    color="error"
                    size="sm"
                    disabled
                    className="opacity-40 cursor-not-allowed text-xs bg-[var(--product-raised)] text-rose-300 border border-[var(--product-line)]"
                  >
                    Reboot device
                  </JXButton>
                ) : (
                  <HoldToConfirmButton
                    label="Reboot device"
                    tone="danger"
                    holdDurationMs={1800}
                    onConfirm={handleRebootNode}
                  />
                )}
              </div>
            </div>

            {/* Offline Enrollment Banner */}
            {isOffline && (
              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-2 flex-1 min-w-0">
                    <div>
                      <h3 className="font-semibold text-sm text-amber-200">Device Offline • Agent Enrollment Required</h3>
                      <p className="text-xs text-amber-300/80 mt-0.5">
                        This device has not connected or reported telemetry yet. Run the enrollment command on the device to connect:
                      </p>
                    </div>
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 p-2.5 rounded-lg bg-[var(--product-canvas)]/80 border border-[var(--product-line)] text-xs font-mono">
                      <code className="text-indigo-300 truncate select-all">
                        {selectedDevice?.platform === "windows"
                          ? `powershell -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '${controlBase}/magic-install.ps1' -OutFile 'magic-install.ps1'; .\\magic-install.ps1 -ControlUrl '${controlBase}'"`
                          : `curl -fsSL ${controlBase}/magic-install.sh | bash -s -- --control-url ${controlBase}`}
                      </code>
                      <JXButton
                        variant="soft"
                        color="primary"
                        size="sm"
                        onClick={() =>
                          handleCopyCommand(
                            selectedDevice?.platform === "windows"
                              ? `powershell -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '${controlBase}/magic-install.ps1' -OutFile 'magic-install.ps1'; .\\magic-install.ps1 -ControlUrl '${controlBase}'"`
                              : `curl -fsSL ${controlBase}/magic-install.sh | bash -s -- --control-url ${controlBase}`
                          )
                        }
                        startIcon={copiedCommand ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-indigo-400" />}
                        className="shrink-0 text-xs"
                      >
                        {copiedCommand ? "Copied" : "Copy Command"}
                      </JXButton>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Action Feedback Notification */}
            {actionFeedback && (
              <JXAlert
                severity={/fail/i.test(actionFeedback) ? "error" : "success"}
                title={/fail/i.test(actionFeedback) ? "Command failed" : "Command Executed"}
                description={actionFeedback}
              />
            )}
          </div>
        </JXCardContent>
      </JXCard>

      {/* 4 Hardware Telemetry Gauges (Bento Units) */}
      <JXGrid columns={12} gap="md">
        {/* Gauge 1: CPU Utilization */}
        <JXGridItem colSpan={3}>
          <JXCard spotlight hoverLift className="bg-[var(--product-surface)]/60 border-[var(--product-line)] h-full">
            <JXCardHeader
              title="CPU"
              icon={<Cpu className="w-4 h-4 text-indigo-400" />}
            />
            <JXCardContent>
              <div className="space-y-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-2xl font-bold text-[var(--product-text)] tabular-nums">
                    {isOffline ? "0.0%" : `${telemetry.cpuPercent.toFixed(1)}%`}
                  </span>
                  <span className="text-[11px] font-mono text-[var(--product-text-tertiary)]">
                    {isOffline ? "Offline" : "Load: Normal"}
                  </span>
                </div>

                {/* Per-core mini bars */}
                <div className="space-y-1.5 p-2 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                  <div className="flex items-center justify-between text-[11px] font-mono text-[var(--product-text-tertiary)]">
                    <span>CORES ({isOffline ? 0 : telemetry.cpuCores.length} vCPU)</span>
                    <span className={isOffline ? "text-[var(--product-text-dim)]" : "text-indigo-400"}>
                      {isOffline ? "Offline" : "Active"}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 pt-0.5">
                    {(isOffline ? [0, 0, 0, 0] : telemetry.cpuCores.slice(0, 8)).map((core, idx) => (
                      <div key={idx} className="space-y-0.5 text-center">
                        <JXLinearProgress value={isOffline ? 0 : core} className="h-1.5" />
                        <span className="text-[11px] font-mono text-[var(--product-text-tertiary)] block tabular-nums">
                          C{idx}: {isOffline ? "0%" : `${core}%`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </JXCardContent>
          </JXCard>
        </JXGridItem>

        {/* Gauge 2: Memory (RAM) */}
        <JXGridItem colSpan={3}>
          <JXCard spotlight hoverLift className="bg-[var(--product-surface)]/60 border-[var(--product-line)] h-full">
            <JXCardHeader
              title="Memory"
              icon={<Layers className="w-4 h-4 text-purple-400" />}
            />
            <JXCardContent>
              <div className="space-y-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-2xl font-bold text-purple-300 tabular-nums">
                    {isOffline ? "0.0 / 0.0 GB" : telemetry.memoryTotalGb > 0 ? `${telemetry.memoryUsedGb} / ${telemetry.memoryTotalGb} GB` : notReported(null)}
                  </span>
                  <span className="text-[11px] font-mono text-[var(--product-text-tertiary)]">
                    {isOffline ? "0%" : telemetry.memoryTotalGb > 0 ? `${Math.round((telemetry.memoryUsedGb / telemetry.memoryTotalGb) * 100)}%` : "—"}
                  </span>
                </div>

                {/* Segmented Memory Breakdown Bar */}
                <div className="space-y-1.5 p-2 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                  <div className="w-full h-2 rounded-full bg-[var(--product-raised)] flex overflow-hidden">
                    {!isOffline && (
                      <>
                        <div className="bg-purple-500 h-full w-[45%]" title="Active Allocations" />
                        <div className="bg-indigo-400 h-full w-[25%]" title="Buffers & Cache" />
                      </>
                    )}
                    <div className="bg-[var(--product-raised)] h-full w-full" title="Free / Offline Space" />
                  </div>
                  <div className="flex justify-between items-center text-[11px] font-mono text-[var(--product-text-tertiary)] pt-0.5">
                    <span>Active: {isOffline ? "0.0G" : `${(telemetry.memoryUsedGb * 0.7).toFixed(1)}G`}</span>
                    <span>Cache: {isOffline ? "0.0G" : `${(telemetry.memoryUsedGb * 0.3).toFixed(1)}G`}</span>
                    <span>Swap: {isOffline ? "0.0G" : `${telemetry.swapUsedGb}G`}</span>
                  </div>
                </div>
              </div>
            </JXCardContent>
          </JXCard>
        </JXGridItem>

        {/* Gauge 3: Storage Volumes */}
        <JXGridItem colSpan={3}>
          <JXCard spotlight hoverLift className="bg-[var(--product-surface)]/60 border-[var(--product-line)] h-full">
            <JXCardHeader
              title="Storage"
              icon={<HardDrive className="w-4 h-4 text-emerald-400" />}
            />
            <JXCardContent>
              <div className="space-y-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-2xl font-bold text-emerald-300 tabular-nums">
                    {isOffline ? "0 / 0 GB" : `${telemetry.diskUsedGb} / ${telemetry.diskTotalGb} GB`}
                  </span>
                  <span className={`text-[11px] font-mono ${isOffline ? "text-[var(--product-text-dim)]" : "text-emerald-400"}`}>
                    {isOffline ? "Offline" : "SMART OK"}
                  </span>
                </div>

                {/* Partition bars */}
                <div className="space-y-2 p-2 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] font-mono text-[var(--product-text-tertiary)]">
                      <span>{selectedDevice.platform === "windows" ? "C:\\ (System Volume)" : "/ (Root Volume)"}</span>
                      <span className="text-[var(--product-text-secondary)] tabular-nums">
                        {isOffline ? "0% used" : `${telemetry.diskPercent}% used`}
                      </span>
                    </div>
                    <JXLinearProgress value={isOffline ? 0 : telemetry.diskPercent} className="h-1.5" />
                  </div>
                </div>
              </div>
            </JXCardContent>
          </JXCard>
        </JXGridItem>

        {/* Gauge 4: Network Throughput */}
        <JXGridItem colSpan={3}>
          <JXCard spotlight hoverLift className="bg-[var(--product-surface)]/60 border-[var(--product-line)] h-full">
            <JXCardHeader
              title="Network"
              icon={<Activity className="w-4 h-4 text-cyan-400" />}
            />
            <JXCardContent>
              <div className="space-y-3">
                <div className="flex items-baseline justify-between font-mono">
                  <div>
                    <span className="text-[11px] text-emerald-400 block font-semibold">RX Rate</span>
                    <span className="text-2xl font-bold text-[var(--product-text)] tabular-nums">
                      {isOffline ? "0.0" : telemetry.networkRxMbps} MB/s
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-[11px] text-cyan-400 block font-semibold">TX Rate</span>
                    <span className="text-2xl font-bold text-[var(--product-text)] tabular-nums">
                      {isOffline ? "0.0" : telemetry.networkTxMbps} MB/s
                    </span>
                  </div>
                </div>

                {/* Sockets Micro-Telemetry */}
                <div className="space-y-1 p-2 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)] text-[11px] font-mono">
                  <div className="flex justify-between items-center">
                    <span className="text-[var(--product-text-tertiary)]">PUBLIC IP:</span>
                    <span className="text-[var(--product-text-secondary)]">
                      {isOffline ? "—" : notReported((import.meta as any).env?.VITE_PUBLIC_IP || telemetry.ipAddress)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[var(--product-text-tertiary)]">PRIVATE IP:</span>
                    <span className="text-[var(--product-text-secondary)]">
                      {isOffline ? "Not assigned" : notReported(telemetry.ipAddress)}
                    </span>
                  </div>
                </div>
              </div>
            </JXCardContent>
          </JXCard>
        </JXGridItem>
      </JXGrid>

      {/* Main 4 JXTabs Panels & Security Fingerprint Layout */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left Side: 4 JXTabs Panels (ColSpan 8) */}
        <div className="xl:col-span-8 space-y-4">
          <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)] overflow-hidden">
            <JXCardContent>
              <div className="space-y-4">
                {overviewError && (
                  <div role="alert" className="p-3 rounded-xl border border-rose-500/40 bg-rose-950/40 text-xs text-rose-300 flex items-center justify-between gap-3">
                    <span>Could not load device diagnostics: {overviewError}</span>
                    <button type="button" onClick={() => setOverviewRetry((c) => c + 1)} className="underline">Retry</button>
                  </div>
                )}
                {/* 4 JXTabs Switcher */}
                <JXTabs
                  value={activeTab}
                  onChange={(val) => setActiveTab(val)}
                  tabs={[
                    {
                      id: "processes",
                      label: `Running Processes (${processes.length})`,
                      icon: <Cpu className="w-3.5 h-3.5 text-indigo-400" />,
                    },
                    {
                      id: "applications",
                      label: `Installed Applications (${installedApps.length})`,
                      icon: <HardDrive className="w-3.5 h-3.5 text-emerald-400" />,
                    },
                    {
                      id: "sockets",
                      label: `Network Sockets & Ports (${listeningSockets.length})`,
                      icon: <Network className="w-3.5 h-3.5 text-cyan-400" />,
                    },
                    {
                      id: "daemons",
                      label: `System Daemons (${daemons.length})`,
                      icon: <Settings className="w-3.5 h-3.5 text-amber-400" />,
                    },
                  ]}
                />

                {/* Tab 1: Running Processes */}
                {activeTab === "processes" && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3 p-2.5 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                      <div className="flex items-center gap-2 flex-1 min-w-[240px]">
                        <JXTextField
                          value={processSearch}
                          onChange={(val) => setProcessSearch(val)}
                          placeholder="Filter by PID, executable name, or user context..."
                          startIcon={<Search className="w-3.5 h-3.5 text-[var(--product-text-tertiary)]" />}
                          size="sm"
                          clearable
                        />
                      </div>

                      <div className="flex items-center gap-2 text-xs font-mono">
                        <span className="text-[var(--product-text-tertiary)]">Sort:</span>
                        <button
                          type="button"
                          aria-label="Sort processes by CPU"
                          aria-pressed={processSortBy === "cpu"}
                          onClick={() => setProcessSortBy("cpu")}
                          className={`px-2.5 py-1.5 rounded-lg ${
                            processSortBy === "cpu" ? "bg-indigo-600 text-white" : "bg-[var(--product-raised)] text-[var(--product-text-tertiary)]"
                          }`}
                        >
                          CPU%
                        </button>
                        <button
                          type="button"
                          aria-label="Sort processes by memory"
                          aria-pressed={processSortBy === "mem"}
                          onClick={() => setProcessSortBy("mem")}
                          className={`px-2.5 py-1.5 rounded-lg ${
                            processSortBy === "mem" ? "bg-indigo-600 text-white" : "bg-[var(--product-raised)] text-[var(--product-text-tertiary)]"
                          }`}
                        >
                          RAM
                        </button>
                        <button
                          type="button"
                          aria-label="Sort processes by PID"
                          aria-pressed={processSortBy === "pid"}
                          onClick={() => setProcessSortBy("pid")}
                          className={`px-2.5 py-1.5 rounded-lg ${
                            processSortBy === "pid" ? "bg-indigo-600 text-white" : "bg-[var(--product-raised)] text-[var(--product-text-tertiary)]"
                          }`}
                        >
                          PID
                        </button>
                      </div>
                    </div>

                    {loadingOverview ? (
                      <div className="p-8 text-center text-[var(--product-text-tertiary)] text-xs">
                        <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin text-indigo-400" />
                        Querying live device processes...
                      </div>
                    ) : isOffline ? (
                      <div className="p-8 rounded-xl bg-[var(--product-raised)]/40 border border-[var(--product-line)] text-center space-y-2">
                        <Radio className="w-6 h-6 mx-auto text-[var(--product-text-dim)]" />
                        <p className="text-sm font-semibold text-[var(--product-text-secondary)]">Device Offline</p>
                        <p className="text-xs text-[var(--product-text-tertiary)] max-w-sm mx-auto">
                          Live process diagnostics will stream here once the AI Bridge edge agent connects.
                        </p>
                      </div>
                    ) : filteredProcesses.length === 0 ? (
                      <EmptyState
                        variant="bare"
                        title="No processes matching filter"
                        description="Try adjusting your search criteria or clear the query."
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs font-mono">
                          <caption className="sr-only">Running processes</caption>
                          <thead>
                            <tr className="border-b border-[var(--product-line)] text-[var(--product-text-tertiary)] uppercase tracking-wider">
                              <th scope="col" aria-sort={processSortBy === "pid" ? "ascending" : "none"} className="py-2.5 px-3">PID</th>
                              <th scope="col" aria-sort={processSortBy === "name" ? "ascending" : "none"} className="py-2.5 px-3">Process Name</th>
                              <th scope="col" className="py-2.5 px-3">User</th>
                              <th scope="col" aria-sort={processSortBy === "cpu" ? "descending" : "none"} className="py-2.5 px-3">CPU %</th>
                              <th scope="col" aria-sort={processSortBy === "mem" ? "descending" : "none"} className="py-2.5 px-3">Memory RSS</th>
                              <th scope="col" className="py-2.5 px-3">State</th>
                              <th scope="col" className="py-2.5 px-3 text-right">Directives</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--product-line)]">
                            {filteredProcesses.map((proc) => (
                              <tr key={proc.pid} className="hover:bg-[var(--product-raised)]/60 transition-colors">
                                <td className="py-2.5 px-3 font-bold text-indigo-300 tabular-nums">
                                  {proc.pid}
                                </td>
                                <td className="py-2.5 px-3 font-semibold text-[var(--product-text-secondary)]">
                                  {proc.name}
                                  {proc.isProtected && (
                                    <span className="ml-2 text-[11px] px-2 py-1 rounded bg-amber-500/20 text-amber-300 font-normal">
                                      Protected
                                    </span>
                                  )}
                                </td>
                                <td className="py-2.5 px-3 text-[var(--product-text-tertiary)]">{proc.user}</td>
                                <td className="py-2.5 px-3 tabular-nums">
                                  <span className={proc.cpuPercent > 10 ? "text-amber-400 font-bold" : "text-[var(--product-text-secondary)]"}>
                                    {proc.cpuPercent.toFixed(1)}%
                                  </span>
                                </td>
                                <td className="py-2.5 px-3 tabular-nums text-[var(--product-text-secondary)]">
                                  {proc.memoryMb} MB
                                </td>
                                <td className="py-2.5 px-3">
                                  <span className="text-[11px] px-2 py-1 rounded bg-[var(--product-raised)] text-[var(--product-text-secondary)]">
                                    {proc.state}
                                  </span>
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  <JXButton
                                    variant="soft"
                                    color="error"
                                    size="sm"
                                    aria-label={`Kill process ${proc.name} (PID ${proc.pid})`}
                                    onClick={() => {
                                      setProcessToKill(proc);
                                      setKillGuardError(null);
                                    }}
                                    startIcon={<Trash2 className="w-3 h-3 text-rose-400" />}
                                    className="text-[11px] bg-rose-500/10 hover:bg-rose-500/20 text-rose-300"
                                  >
                                    Kill
                                  </JXButton>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Tab 2: Installed Applications */}
                {activeTab === "applications" && (
                  <div className="space-y-3">
                    {loadingOverview ? (
                      <div className="p-8 text-center text-[var(--product-text-tertiary)] text-xs">
                        <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin text-indigo-400" />
                        Querying installed packages...
                      </div>
                    ) : isOffline ? (
                      <div className="p-8 rounded-xl bg-[var(--product-raised)]/40 border border-[var(--product-line)] text-center space-y-2">
                        <Radio className="w-6 h-6 mx-auto text-[var(--product-text-dim)]" />
                        <p className="text-sm font-semibold text-[var(--product-text-secondary)]">Device Offline</p>
                        <p className="text-xs text-[var(--product-text-tertiary)] max-w-sm mx-auto">
                          Software inventory will be discovered and listed here when the device connects.
                        </p>
                      </div>
                    ) : installedApps.length === 0 ? (
                      <EmptyState
                        variant="bare"
                        title="No installed packages reported"
                        description="The remote agent has not detected standard application binaries."
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs font-mono">
                          <caption className="sr-only">Installed applications</caption>
                          <thead>
                            <tr className="border-b border-[var(--product-line)] text-[var(--product-text-tertiary)] uppercase tracking-wider">
                              <th scope="col" className="py-2.5 px-3">Application Binary</th>
                              <th scope="col" className="py-2.5 px-3">Version</th>
                              <th scope="col" className="py-2.5 px-3">Publisher</th>
                              <th scope="col" className="py-2.5 px-3">Category</th>
                              <th scope="col" className="py-2.5 px-3">Binary Location</th>
                              <th scope="col" className="py-2.5 px-3 text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--product-line)]">
                            {installedApps.map((app) => (
                              <tr key={app.id} className="hover:bg-[var(--product-raised)]/60 transition-colors">
                                <td className="py-2.5 px-3 font-semibold text-[var(--product-text-secondary)]">
                                  {app.name}
                                </td>
                                <td className="py-2.5 px-3 text-indigo-300 font-bold">{app.version}</td>
                                <td className="py-2.5 px-3 text-[var(--product-text-tertiary)]">{app.publisher}</td>
                                <td className="py-2.5 px-3">
                                  <span className="text-[11px] px-2 py-1 rounded bg-[var(--product-raised)] text-[var(--product-text-secondary)]">
                                    {app.category}
                                  </span>
                                </td>
                                <td className="py-2.5 px-3">
                                  <code className="text-[11px] px-2 py-1 rounded bg-[var(--product-raised)] text-[var(--product-text-secondary)]">
                                    {app.binaryPath}
                                  </code>
                                </td>
                                <td className="py-2.5 px-3 text-right">
                                  <JXButton
                                    variant="soft"
                                    color="primary"
                                    size="sm"
                                    aria-label={`Launch ${app.name}`}
                                    onClick={() =>
                                      setActionFeedback(`Application "${app.name}" launch signal dispatched.`)
                                    }
                                    startIcon={<Play className="w-3 h-3 text-emerald-400" />}
                                    className="text-[11px] bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)]"
                                  >
                                    Launch
                                  </JXButton>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Tab 3: Network Sockets & Ports */}
                {activeTab === "sockets" && (
                  <div className="space-y-3">
                    {loadingOverview ? (
                      <div className="p-8 text-center text-[var(--product-text-tertiary)] text-xs">
                        <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin text-indigo-400" />
                        Scanning listening ports and sockets...
                      </div>
                    ) : isOffline ? (
                      <div className="p-8 rounded-xl bg-[var(--product-raised)]/40 border border-[var(--product-line)] text-center space-y-2">
                        <Radio className="w-6 h-6 mx-auto text-[var(--product-text-dim)]" />
                        <p className="text-sm font-semibold text-[var(--product-text-secondary)]">Device Offline</p>
                        <p className="text-xs text-[var(--product-text-tertiary)] max-w-sm mx-auto">
                          Active network sockets and listening ports will appear here once the agent connects.
                        </p>
                      </div>
                    ) : listeningSockets.length === 0 ? (
                      <EmptyState
                        variant="bare"
                        title="No active listening sockets reported"
                        description="All inbound ports are either filtered or inactive."
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs font-mono">
                          <caption className="sr-only">Network sockets and ports</caption>
                          <thead>
                            <tr className="border-b border-[var(--product-line)] text-[var(--product-text-tertiary)] uppercase tracking-wider">
                              <th scope="col" className="py-2.5 px-3">Port</th>
                              <th scope="col" className="py-2.5 px-3">Protocol</th>
                              <th scope="col" className="py-2.5 px-3">Local Address</th>
                              <th scope="col" className="py-2.5 px-3">Foreign Address</th>
                              <th scope="col" className="py-2.5 px-3">State</th>
                              <th scope="col" className="py-2.5 px-3">Bound Service Description</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--product-line)]">
                            {listeningSockets.map((s) => (
                              <tr key={s.port} className="hover:bg-[var(--product-raised)]/60 transition-colors">
                                <td className="py-2.5 px-3 font-bold text-cyan-300 tabular-nums">
                                  :{s.port}
                                </td>
                                <td className="py-2.5 px-3 text-indigo-300 font-semibold">{s.protocol}</td>
                                <td className="py-2.5 px-3 text-[var(--product-text-secondary)]">{s.localAddress}</td>
                                <td className="py-2.5 px-3 text-[var(--product-text-tertiary)]">{s.foreignAddress}</td>
                                <td className="py-2.5 px-3">
                                  <StatusBadge status={s.state === "LISTEN" ? "success" : "info"} label={s.state} />
                                </td>
                                <td className="py-2.5 px-3 text-[var(--product-text-secondary)]">{s.service}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Tab 4: System Daemons */}
                {activeTab === "daemons" && (
                  <div className="space-y-3">
                    {loadingOverview ? (
                      <div className="p-8 text-center text-[var(--product-text-tertiary)] text-xs">
                        <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin text-indigo-400" />
                        Inspecting system service daemons...
                      </div>
                    ) : isOffline ? (
                      <div className="p-8 rounded-xl bg-[var(--product-raised)]/40 border border-[var(--product-line)] text-center space-y-2">
                        <Radio className="w-6 h-6 mx-auto text-[var(--product-text-dim)]" />
                        <p className="text-sm font-semibold text-[var(--product-text-secondary)]">Device Offline</p>
                        <p className="text-xs text-[var(--product-text-tertiary)] max-w-sm mx-auto">
                          Background daemons and system services will appear here once the agent connects.
                        </p>
                      </div>
                    ) : daemons.length === 0 ? (
                      <EmptyState
                        variant="bare"
                        title="No managed daemons reported"
                        description="System services are managed by the device OS init system."
                      />
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs font-mono">
                          <caption className="sr-only">System daemons</caption>
                          <thead>
                            <tr className="border-b border-[var(--product-line)] text-[var(--product-text-tertiary)] uppercase tracking-wider">
                              <th scope="col" className="py-2.5 px-3">Service Daemon</th>
                              <th scope="col" className="py-2.5 px-3">Description</th>
                              <th scope="col" className="py-2.5 px-3">Status</th>
                              <th scope="col" className="py-2.5 px-3">PID</th>
                              <th scope="col" className="py-2.5 px-3">RAM</th>
                              <th scope="col" className="py-2.5 px-3">Restarts</th>
                              <th scope="col" className="py-2.5 px-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--product-line)]">
                            {daemons.map((daemon) => (
                              <tr key={daemon.name} className="hover:bg-[var(--product-raised)]/60 transition-colors">
                                <td className="py-2.5 px-3 font-bold text-[var(--product-text)]">{daemon.name}</td>
                                <td className="py-2.5 px-3 text-[var(--product-text-tertiary)]">{daemon.description}</td>
                                <td className="py-2.5 px-3">
                                  <StatusBadge status={daemon.status === "active" ? "active" : "error"} label={daemon.status} />
                                </td>
                                <td className="py-2.5 px-3 text-[var(--product-text-secondary)]">{daemon.pid || "—"}</td>
                                <td className="py-2.5 px-3 text-[var(--product-text-secondary)]">{daemon.memoryMb} MB</td>
                                <td className="py-2.5 px-3 text-[var(--product-text-tertiary)]">{daemon.restarts}</td>
                                <td className="py-2.5 px-3 text-right">
                                  <div className="flex items-center justify-end gap-1.5">
                                    {daemon.status === "active" ? (
                                      <JXButton
                                        variant="soft"
                                        color="error"
                                        size="sm"
                                        disabled={daemonPending === daemon.name}
                                        loading={daemonPending === daemon.name}
                                        aria-label={`Stop ${daemon.name}`}
                                        onClick={() => setDaemonConfirm({ name: daemon.name, action: "stop" })}
                                        className="text-[11px]"
                                      >
                                        Stop
                                      </JXButton>
                                    ) : (
                                      <JXButton
                                        variant="soft"
                                        color="primary"
                                        size="sm"
                                        disabled={daemonPending === daemon.name}
                                        loading={daemonPending === daemon.name}
                                        aria-label={`Start ${daemon.name}`}
                                        onClick={() => handleDaemonAction(daemon.name, "start")}
                                        className="text-[11px]"
                                      >
                                        Start
                                      </JXButton>
                                    )}
                                    <JXButton
                                      variant="soft"
                                      color="neutral"
                                      size="sm"
                                      disabled={daemonPending === daemon.name}
                                      loading={daemonPending === daemon.name}
                                      aria-label={`Restart ${daemon.name}`}
                                      onClick={() => handleDaemonAction(daemon.name, "restart")}
                                      className="text-[11px]"
                                    >
                                      Restart
                                    </JXButton>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </JXCardContent>
          </JXCard>
        </div>

        {/* Right Side: Security Fingerprint Card (ColSpan 4) */}
        <div className="xl:col-span-4 space-y-4">
          <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
            <JXCardHeader
              title="Security Fingerprint"
              subheader="Zero-Trust mTLS & TPM PCR Attestation"
              icon={<ShieldCheck className="w-4 h-4 text-emerald-400" />}
            />
            <JXCardContent>
              <div className="space-y-3 font-mono text-xs">
                {/* SHA-256 Fingerprint — P1-3: the REAL mTLS fingerprint
                    from the overview response (device.mtls_fingerprint).
                    The seeded telemetry.fingerprintSha256 shown here
                    before was demo data, not the device's fingerprint. */}
                <div className="space-y-1 p-2.5 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                  <span className="text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider block">
                    Device SHA-256 Fingerprint
                  </span>
                  <code className="text-[11px] text-indigo-300 break-all select-all block">
                    {overviewDevice?.mtls_fingerprint ? overviewDevice.mtls_fingerprint : notReported(null)}
                  </code>
                  {isLive && isAdmin && (
                    <form
                      className="space-y-2 pt-2"
                      onSubmit={(e) => { e.preventDefault(); void handleSaveFingerprint(); }}
                    >
                      <label htmlFor="mtls-fingerprint-input" className="text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider block">
                        Set mTLS fingerprint
                      </label>
                      <input
                        id="mtls-fingerprint-input"
                        value={fingerprintDraft}
                        onChange={(e) => setFingerprintDraft(e.target.value)}
                        placeholder="Hex, with optional colons or spaces"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={fingerprintSaving}
                        className="w-full bg-[var(--product-surface)] border border-[var(--product-line)] text-[var(--product-text-secondary)] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <JXButton
                          variant="soft"
                          color="neutral"
                          size="sm"
                          type="submit"
                          disabled={fingerprintSaving || !fingerprintDraft.trim()}
                          loading={fingerprintSaving}
                        >
                          Save fingerprint
                        </JXButton>
                        <JXButton
                          variant="soft"
                          color="error"
                          size="sm"
                          type="button"
                          disabled={fingerprintSaving || !overviewDevice?.mtls_fingerprint}
                          title={overviewDevice?.mtls_fingerprint ? "Remove the registered mTLS fingerprint." : "No fingerprint is registered."}
                          onClick={() => setClearFingerprintConfirm(true)}
                        >
                          Clear fingerprint
                        </JXButton>
                      </div>
                      <p className="text-[11px] text-[var(--product-text-tertiary)] normal-case tracking-normal">
                        Hex with optional colons or spaces; the control plane normalizes it.
                      </p>
                    </form>
                  )}
                  {isLive && !isAdmin && (
                    <p className="text-[11px] text-[var(--product-text-tertiary)] pt-1">
                      An administrator can set or clear the mTLS fingerprint.
                    </p>
                  )}
                </div>

                {/* Device token expiry — P1-3: from list_devices' token_expires_at
                    (store-mapped) so an expiring token is visible here too. */}
                <div className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                  <div>
                    <span className="text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider block">
                      Device token
                    </span>
                    <span className="text-[var(--product-text-secondary)] font-semibold">
                      {selectedDevice.tokenExpiresAt
                        ? `Expires ${formatDate(new Date(selectedDevice.tokenExpiresAt * 1000), { dateStyle: "medium", timeStyle: "short" })}`
                        : notReported(null)}
                    </span>
                  </div>
                  {(() => {
                    const expiryStatus = tokenExpiryStatus(selectedDevice.tokenExpiresAt);
                    if (expiryStatus === "expired") return <StatusBadge status="error" label="Token expired" />;
                    if (expiryStatus === "expiring") return <StatusBadge status="warning" label="Token expiring soon" />;
                    return null;
                  })()}
                </div>

                {/* mTLS Cert Expiry */}
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                  <div>
                    <span className="text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider block">
                      mTLS Cert Expiry
                    </span>
                    <span className={`font-bold ${isOffline ? "text-[var(--product-text-tertiary)]" : "text-emerald-400"}`}>
                      {isOffline ? "Offline (Agent not enrolled)" : telemetry.certExpiryDays > 0 ? `Expires in ${telemetry.certExpiryDays} days` : notReported(null)}
                    </span>
                  </div>
                  {isOffline ? <AlertTriangle className="w-4 h-4 text-amber-400" /> : <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                </div>

                {/* TPM 2.0 PCR Status */}
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                  <div>
                    <span className="text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider block">
                      TPM 2.0 Status
                    </span>
                    <span className="text-[var(--product-text-secondary)] font-semibold uppercase">
                      {isOffline ? "Offline (No attestation)" : telemetry.tpmStatus === "active" ? "active PCR-7 Key-Bound" : notReported(null)}
                    </span>
                  </div>
                  <Lock className="w-4 h-4 text-indigo-400" />
                </div>

                {/* Cipher Suite */}
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                  <div>
                    <span className="text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider block">
                      Cipher Suite
                    </span>
                    <span className="text-indigo-300 font-semibold">
                      {isOffline ? "None (Offline)" : "TLS_AES_256_GCM"}
                    </span>
                  </div>
                  <Shield className="w-4 h-4 text-indigo-400" />
                </div>

                {/* Security Enforcement */}
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--product-raised)]/80 border border-[var(--product-line)]">
                  <div>
                    <span className="text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider block">
                      SELinux / AppArmor
                    </span>
                    <span className={`font-semibold ${isOffline ? "text-[var(--product-text-tertiary)]" : "text-emerald-400"}`}>
                      {isOffline ? "Offline" : "Enforcing"}
                    </span>
                  </div>
                  {isOffline ? <XCircle className="w-4 h-4 text-[var(--product-text-dim)]" /> : <Check className="w-4 h-4 text-emerald-400" />}
                </div>
              </div>
            </JXCardContent>
          </JXCard>
        </div>
      </div>

      {/* Kill Process Confirmation Modal */}
      {processToKill && (
        <GlassModal
          open={Boolean(processToKill)}
          onClose={() => {
            setProcessToKill(null);
            setKillGuardError(null);
          }}
          title={`Confirm Process Termination: PID ${processToKill.pid}`}
        >
          <div className="space-y-4 max-w-md w-full text-xs font-mono">
            {killGuardError ? (
              <JXAlert severity="error" title="Action Prohibited" description={killGuardError} />
            ) : (
              <p className="text-[var(--product-text-secondary)]">
                Are you sure you want to terminate process <strong className="text-indigo-300">{processToKill.name}</strong> (PID {processToKill.pid}) running under user {processToKill.user}? A SIGTERM signal will be sent to the device.
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--product-line)]">
              <JXButton
                variant="soft"
                color="neutral"
                size="sm"
                onClick={() => {
                  setProcessToKill(null);
                  setKillGuardError(null);
                }}
              >
                Cancel
              </JXButton>
              {!killGuardError && (
                <JXButton
                  variant="contained"
                  color="error"
                  size="sm"
                  onClick={handleConfirmKillProcess}
                  className="bg-rose-600 hover:bg-rose-500"
                >
                  Kill Process
                </JXButton>
              )}
            </div>
          </div>
        </GlassModal>
      )}

      {/* Daemon stop confirmation (UX-03) */}
      <ConfirmDestructive
        open={daemonConfirm !== null}
        title="Stop system daemon"
        objectName={daemonConfirm ? `${daemonConfirm.name} on ${selectedDevice.hostname}` : undefined}
        consequence="Stop: halts the service on the device. The device may restart it, or you can start it again from this view."
        confirmLabel="Stop daemon"
        onConfirm={() => {
          const pending = daemonConfirm;
          setDaemonConfirm(null);
          if (pending) void handleDaemonAction(pending.name, "stop");
        }}
        onCancel={() => setDaemonConfirm(null)}
      />

      {/* P1-3: rotate-token confirmation (hold-to-confirm: the old token dies immediately). */}
      <ConfirmDestructive
        open={rotateConfirm}
        title="Rotate device token"
        objectName={`${selectedDevice.hostname} (${selectedDevice.id})`}
        consequence="Rotate: invalidates the device's current token immediately. The device must be given the new token to reconnect, and the new token is shown only once."
        confirmLabel="Rotate token"
        requireHold
        tone="warning"
        onConfirm={() => {
          setRotateConfirm(false);
          void handleRotateDeviceToken();
        }}
        onCancel={() => setRotateConfirm(false)}
      />
      {/* P1-3: new token, shown exactly once. Dismissing clears it from
          component state; it is never persisted (no store, no storage, no URL). */}
      {rotatedToken && (
        <GlassModal
          open={Boolean(rotatedToken)}
          onClose={() => { setRotatedToken(null); setCopiedRotatedToken(false); }}
          title={`New token for ${selectedDevice.hostname}`}
        >
          <div className="space-y-4 max-w-md w-full text-xs">
            <p className="text-amber-300">
              Shown once — copy it now. It will not be shown again, and the old token no longer works.
            </p>
            <div className="space-y-1">
              <label htmlFor="rotated-device-token-360" className="text-[var(--product-text-secondary)] font-semibold block">
                Device token
              </label>
              <input
                id="rotated-device-token-360"
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
      {/* P1-3: clear-fingerprint confirmation. */}
      <ConfirmDestructive
        open={clearFingerprintConfirm}
        title="Clear mTLS fingerprint"
        objectName={`${selectedDevice.hostname} (${selectedDevice.id})`}
        consequence="Clear: removes the registered mTLS fingerprint. If device mTLS is enforced, the device cannot authenticate until a new fingerprint is set."
        confirmLabel="Clear fingerprint"
        onConfirm={() => {
          setClearFingerprintConfirm(false);
          void handleClearFingerprint();
        }}
        onCancel={() => setClearFingerprintConfirm(false)}
      />
    </div>
  );
};

export default Device360View;
