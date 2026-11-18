/**
 * Service Diagnostics & Systemd Log Stream Hub (Screen 14)
 * Reconstructed with pure JXUI primitives, motion/react, and lucide-react.
 * ZERO inline styles. ZERO custom CSS.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  JXCard,
  JXCardHeader,
  JXCardContent,
  JXButton,
  JXBadge,
  JXSwitch,
  JXSelect,
  JXTextField,
  JXGrid,
  JXGridItem,
  JXLinearProgress,
  StatusBadge,
  EmptyState,
} from "../ui";
import {
  Terminal,
  Activity,
  Pause,
  Play,
  Copy,
  Check,
  Download,
  Trash2,
  Search,
  Filter,
  Server,
  Layers,
  Shield,
  Clock,
  Pin,
  ExternalLink,
  ChevronRight,
  HardDrive,
  Cpu,
  FileCode,
  RefreshCw,
} from "lucide-react";
import { api, token, sessionToken } from "../api";
import { useDashboardStore } from "../state/dashboardStore";
import { pushNotice } from "../state/notices";
import { Freshness } from "../components/Freshness";
import { useLanguage } from "../i18n";
import type { LogRecord } from "../types/dashboard";

interface StructuredLogEntry {
  id: string;
  timestamp: string;
  service: string;
  moduleTag: string;
  workerThread: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
  message: string;
  pid: number;
  traceId: string;
  details: Record<string, unknown>;
}

type BackendLogService = "control" | "mcp" | "oauth" | "nginx";

const SEED_STORE_LOG_IDS = new Set(["log-1", "log-2", "log-3", "log-4"]);

function mapToBackendService(targetService: string): BackendLogService {
  const lower = targetService.toLowerCase();
  if (lower.includes("mcp")) return "mcp";
  if (lower.includes("nginx")) return "nginx";
  if (lower.includes("oauth") || lower.includes("edge") || lower.includes("journal")) return "oauth";
  return "control";
}

function parseRawLogLine(
  raw: unknown,
  idx: number,
  backendService: BackendLogService,
  serviceLabel: string
): StructuredLogEntry {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const lvlRaw = String(obj.level || "INFO").toUpperCase();
    const level: StructuredLogEntry["level"] =
      lvlRaw === "DEBUG" || lvlRaw === "WARN" || lvlRaw === "ERROR" || lvlRaw === "FATAL"
        ? lvlRaw
        : "INFO";
    return {
      id: String(obj.id || `live-${backendService}-${idx}`),
      timestamp: String(obj.timestamp || new Date().toISOString()),
      service: String(obj.service || serviceLabel),
      moduleTag: String(obj.moduleTag || `${backendService}::service`),
      workerThread: String(obj.workerThread || `${backendService}-worker`),
      level,
      message: String(obj.message || JSON.stringify(obj)),
      pid: Number(obj.pid || 1000 + idx),
      traceId: String(obj.traceId || `trc-${backendService}-${idx + 1}`),
      details: (obj.details && typeof obj.details === "object" ? obj.details : obj) as Record<string, unknown>,
    };
  }

  const line = String(raw ?? "");
  const isoMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
  const timestamp = isoMatch ? isoMatch[1].replace(" ", "T") : new Date().toISOString();
  const lvlMatch = line.match(/\b(FATAL|ERROR|WARN|WARNING|DEBUG|INFO)\b/i);
  const matchedUpper = lvlMatch ? lvlMatch[1].toUpperCase() : "INFO";
  const level: StructuredLogEntry["level"] =
    matchedUpper === "WARNING"
      ? "WARN"
      : matchedUpper === "DEBUG" || matchedUpper === "WARN" || matchedUpper === "ERROR" || matchedUpper === "FATAL"
      ? matchedUpper
      : "INFO";

  return {
    id: `live-${backendService}-${idx}`,
    timestamp: timestamp.length >= 23 ? timestamp : new Date().toISOString(),
    service: serviceLabel,
    moduleTag: `${backendService}::journal`,
    workerThread: `${backendService}-01`,
    level,
    message: line,
    pid: 1000 + idx,
    traceId: `trc-${backendService}-${String(idx + 1).padStart(4, "0")}`,
    details: {
      service: backendService,
      unit: serviceLabel,
      line: idx + 1,
      raw: line,
    },
  };
}

export const DiagnosticsLogsView: React.FC = () => {
  const storeLogs = useDashboardStore((s) => s.logs);
  const setCurrentView = useDashboardStore((s) => s.setCurrentView);
  const refreshLive = useDashboardStore((s) => s.refreshLive);
  // UX-06: sync freshness in the header when live; UX-29: timestamps and
  // relative times go through useLanguage().date with an explicit timeZone.
  const syncState = useDashboardStore((s) => s.syncState);
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const syncError = useDashboardStore((s) => s.syncError);
  const { date } = useLanguage();

  const isLive = typeof window !== "undefined" && Boolean(token() || sessionToken());

  // Stream state
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [logLevelFilter, setLogLevelFilter] = useState<string>("ALL");
  const [targetService, setTargetService] = useState<string>("ai-bridge-core.service");
  const [bufferSize, setBufferSize] = useState<number>(500);
  const [regexQuery, setRegexQuery] = useState<string>("");
  const [copiedBuffer, setCopiedBuffer] = useState<boolean>(false);
  const [activeTraceFilter, setActiveTraceFilter] = useState<string | null>(null);

  // Live service logs fetched from api.logs(service, bufferSize)
  const [liveServiceLogs, setLiveServiceLogs] = useState<StructuredLogEntry[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState<boolean>(false);
  const [logFetchError, setLogFetchError] = useState<string | null>(null);
  // UX-18: a 401 clears the credential, which would otherwise make this
  // view silently fall back to the seed demo logs. Show an expired state
  // instead of seed data.
  const [expired, setExpired] = useState(false);

  // UX-20: the regex filter is validated as typed; an invalid pattern is
  // a field error (aria-invalid + aria-describedby), not a silent fallback.
  const regexError = useMemo(() => {
    if (!regexQuery) return null;
    try {
      new RegExp(regexQuery, "i");
      return null;
    } catch {
      return "That regular expression is invalid — showing plain-text matches instead. Fix the pattern to filter by regex.";
    }
  }, [regexQuery]);

  const backendService = useMemo(() => mapToBackendService(targetService), [targetService]);

  const fetchServiceLogs = useCallback(async () => {
    if (!isLive) return;
    const wasLive = Boolean(token() || sessionToken());
    setIsLoadingLogs(true);
    setLogFetchError(null);
    try {
      const res = await api.logs(backendService, bufferSize);
      const rawLines: unknown[] = Array.isArray(res?.lines)
        ? res.lines
        : Array.isArray(res?.logs)
        ? res.logs
        : Array.isArray(res)
        ? res
        : [];
      const parsed = rawLines
        .filter((l) => l !== null && l !== undefined && String(l).trim() !== "")
        .map((l, idx) => parseRawLogLine(l, idx, backendService, targetService));
      setLiveServiceLogs(parsed);
      setExpired(false);
    } catch (err) {
      // UX-18: map common statuses to plain language with a next step.
      const status = (err as { status?: number })?.status;
      if (wasLive && status === 401) {
        setExpired(true);
        setLogFetchError(null);
        pushNotice({
          tone: "error",
          title: "Your session expired",
          message: "Sign in again to keep streaming live logs.",
          actionLabel: "Sign in",
          actionHref: "#/login",
        });
        return;
      }
      setLogFetchError(
        status === 403
          ? "Access denied (403). Your account may lack permission to read service logs — ask an admin to check your role."
          : status === 429
            ? "Too many requests (429). Wait a minute, then use Retry."
            : status && status >= 500
              ? `Control plane error (${status}). The log service failed — use Retry, and check the audit trail if the problem persists.`
              : err instanceof Error ? err.message : "Failed to load service logs."
      );
    } finally {
      setIsLoadingLogs(false);
    }
  }, [isLive, backendService, bufferSize, targetService]);

  useEffect(() => {
    if (isLive && !isPaused) {
      void fetchServiceLogs();
    }
  }, [isLive, isPaused, fetchServiceLogs]);

  const handleRefreshLogs = useCallback(async () => {
    if (isLive) {
      await Promise.all([
        fetchServiceLogs(),
        refreshLive ? refreshLive() : Promise.resolve(),
      ]);
    }
  }, [isLive, fetchServiceLogs, refreshLive]);

  // Selected entry for structured JSON drawer
  const [selectedEntry, setSelectedEntry] = useState<StructuredLogEntry | null>(null);

  // Spacebar hotkey for stream pause
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.code === "Space" &&
        target.tagName !== "INPUT" &&
        target.tagName !== "TEXTAREA" &&
        !target.isContentEditable
      ) {
        e.preventDefault();
        setIsPaused((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Default seed entries matching Stitch reference
  const defaultLogs: StructuredLogEntry[] = useMemo(
    () => [
      {
        id: "log-01",
        timestamp: "2026-11-02T14:28:09.102Z",
        service: "ai-bridge-core.service",
        moduleTag: "core::mTLS",
        workerThread: "worker-01",
        level: "INFO",
        message: "mTLS handshake completed node=srv-us-east-412 cipher=TLS_AES_256_GCM_SHA384 latency=3.2ms session_id=0xfa49c12b",
        pid: 84019,
        traceId: "trc-890a-11ef-93cc",
        details: {
          node_id: "srv-us-east-412",
          ip: "10.244.18.99",
          tls_version: "1.3",
          cipher_suite: "TLS_AES_256_GCM_SHA384",
          session_resumed: false,
          cert_fingerprint: "sha256:d9a4...6b01",
          handshake_latency_ms: 3.2,
        },
      },
      {
        id: "log-02",
        timestamp: "2026-11-02T14:28:09.418Z",
        service: "ai-bridge-core.service",
        moduleTag: "policy::ast",
        workerThread: "worker-04",
        level: "DEBUG",
        message: "AST policy syntax tree match validated rule_set=v3.4.1 depth=4 eval_time=180µs policy_id=pol-sec-99",
        pid: 84022,
        traceId: "trc-890a-11ef-93cc",
        details: {
          rule_set: "v3.4.1",
          depth: 4,
          eval_time_us: 180,
          policy_id: "pol-sec-99",
          verdict: "allow",
        },
      },
      {
        id: "log-03",
        timestamp: "2026-11-02T14:28:10.005Z",
        service: "ai-bridge-mcp-gateway",
        moduleTag: "mcp::stream",
        workerThread: "worker-02",
        level: "INFO",
        message: "SSE client connected client_id=cursor-ide route=/mcp/v1/fleet-desktop pid=4912 buffer_depth=128",
        pid: 84100,
        traceId: "trc-991b-44ec-10aa",
        details: {
          client_id: "cursor-ide",
          route: "/mcp/v1/fleet-desktop",
          client_pid: 4912,
          buffer_depth: 128,
        },
      },
      {
        id: "log-04",
        timestamp: "2026-11-02T14:28:11.190Z",
        service: "ai-bridge-edge-daemon",
        moduleTag: "agent::telemetry",
        workerThread: "worker-03",
        level: "WARN",
        message: "Memory RSS utilization approaching high threshold node=srv-us-east-412 used=18.4GB total=64.0GB pct=28.7%",
        pid: 84033,
        traceId: "trc-104d-77ef-22ba",
        details: {
          node_id: "srv-us-east-412",
          memory_used_gb: 18.4,
          memory_total_gb: 64.0,
          memory_pct: 28.7,
        },
      },
      {
        id: "log-05",
        timestamp: "2026-11-02T14:28:12.802Z",
        service: "systemd-journald",
        moduleTag: "kernel::filter",
        workerThread: "kernel-io",
        level: "ERROR",
        message: "Execution blocked by eBPF allowlist binary=/usr/bin/nc target_path=/usr/bin/nc pid=90118 reason=blocked_unauthorized_socket",
        pid: 90118,
        traceId: "trc-5591-99ad-ff41",
        details: {
          blocked_binary: "/usr/bin/nc",
          target_pid: 90118,
          violation_rule: "RESTRICTED_BINARY_POLICY",
          enforcement_point: "ebpf_sys_enter_execve",
        },
      },
    ],
    []
  );

  const mappedStoreLogs: StructuredLogEntry[] = useMemo(
    () =>
      storeLogs.map((l, idx) => ({
        id: l.id || `store-log-${idx}`,
        timestamp: l.timestamp || new Date().toISOString(),
        service: l.service || "ai-bridge-control",
        moduleTag: l.moduleTag || "core::audit",
        workerThread: l.workerThread || "operator",
        level: l.level || "INFO",
        message: l.message || "",
        pid: l.pid || 1000 + idx,
        traceId: l.traceId || `trc-audit-${idx + 1}`,
        details: (l.details || {}) as Record<string, unknown>,
      })),
    [storeLogs]
  );

  const activeLogs: StructuredLogEntry[] = useMemo(() => {
    if (expired) return [];
    if (!isLive) return defaultLogs;
    const realStoreLogs = mappedStoreLogs.filter((l) => !SEED_STORE_LOG_IDS.has(l.id));
    return [...liveServiceLogs, ...realStoreLogs];
  }, [expired, isLive, defaultLogs, liveServiceLogs, mappedStoreLogs]);

  // Initialize selected entry
  useEffect(() => {
    if (activeLogs.length > 0 && (!selectedEntry || !activeLogs.some((l) => l.id === selectedEntry.id))) {
      setSelectedEntry(activeLogs[0]);
    }
  }, [activeLogs, selectedEntry]);

  // Ring Buffer calculations (F30)
  const ringBufferTotalMb = 64.0;
  const ringBufferUsedMb = useMemo(() => {
    if (!isLive) return 30.72;
    const totalBytes = activeLogs.reduce(
      (acc, l) => acc + (l.message?.length || 0) + (l.timestamp?.length || 0) + 64,
      0
    );
    return Number(Math.min(ringBufferTotalMb, Math.max(0.01, totalBytes / (1024 * 1024))).toFixed(2));
  }, [isLive, activeLogs]);
  const ringBufferPercent = Math.round((ringBufferUsedMb / ringBufferTotalMb) * 100);

  const getRingBufferColor = (pct: number) => {
    if (pct >= 90) return "text-rose-400";
    if (pct >= 80) return "text-amber-400";
    return "text-emerald-400";
  };

  // Filtered logs
  const filteredLogs = useMemo(() => {
    return activeLogs.filter((entry) => {
      if (logLevelFilter !== "ALL" && entry.level !== logLevelFilter) return false;
      if (activeTraceFilter && entry.traceId !== activeTraceFilter) return false;
      if (regexQuery) {
        try {
          const reg = new RegExp(regexQuery, "i");
          if (!reg.test(entry.message) && !reg.test(entry.moduleTag)) return false;
        } catch {
          // invalid regex: fallback to simple string check
          if (!entry.message.toLowerCase().includes(regexQuery.toLowerCase())) return false;
        }
      }
      return true;
    });
  }, [activeLogs, logLevelFilter, activeTraceFilter, regexQuery]);

  const handleCopyBuffer = () => {
    const raw = filteredLogs.map((l) => `${l.timestamp} [${l.workerThread}] [${l.moduleTag}] ${l.level} ${l.message}`).join("\n");
    navigator.clipboard.writeText(raw);
    setCopiedBuffer(true);
    setTimeout(() => setCopiedBuffer(false), 2000);
  };

  const handleDownloadLog = async () => {
    const raw = filteredLogs.map((l) => `${l.timestamp} [${l.workerThread}] [${l.moduleTag}] ${l.level} ${l.message}`).join("\n");
    const ts = Date.now();
    let blob: Blob;
    let filename = `diagnostics-journal-${ts}.log`;
    if (typeof CompressionStream !== "undefined") {
      try {
        const encoded = new TextEncoder().encode(raw);
        const compressedStream = new Blob([encoded]).stream().pipeThrough(new CompressionStream("gzip"));
        blob = await new Response(compressedStream).blob();
        filename = `diagnostics-journal-${ts}.log.gz`;
      } catch {
        blob = new Blob([raw], { type: "text/plain;charset=utf-8" });
      }
    } else {
      blob = new Blob([raw], { type: "text/plain;charset=utf-8" });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleFlushBuffer = () => {
    setActiveTraceFilter(null);
    setRegexQuery("");
    setLogLevelFilter("ALL");
  };

  return (
    <div className="space-y-4">
      {/* UX-36: explicit top-level heading (this view previously had none). */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-[var(--product-text)]">Diagnostics &amp; logs</h1>
          <p className="text-xs text-[var(--product-text-tertiary)]">
            Live service logs from the control plane{isLive ? "" : " — sign in to stream live logs; the entries below are samples"}.
            Press Space to pause or resume the stream.
          </p>
        </div>
        {isLive && (
          <Freshness checkedAt={lastSyncAt} loading={syncState === "loading"} label="Updated" />
        )}
      </header>
      {isLive && syncState === "error" && !expired && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-700/50 bg-rose-950/30 px-4 py-2 text-xs text-rose-300">
          <span>Sync with the control plane failed{syncError ? `: ${syncError}` : "."} Showing the last known data.</span>
          <JXButton variant="outlined" color="neutral" size="sm" onClick={() => void refreshLive?.()}>Retry</JXButton>
        </div>
      )}
      {expired && (
        <EmptyState
          variant="card"
          title="Your session expired"
          description="Sign in again to resume the live log stream. Sample entries are hidden until you do, so nothing here can be mistaken for live data."
          actionLabel="Sign in"
          onAction={() => setCurrentView("login")}
        />
      )}
      {/* Status Ribbon with Ingest EPS and Ring Buffer Meter */}
      <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
        <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs font-mono">
          <div className="flex items-center gap-2 flex-wrap">
            <JXButton
              variant={isPaused ? "contained" : "soft"}
              color={isPaused ? "warning" : "neutral"}
              size="sm"
              onClick={() => setIsPaused(!isPaused)}
              startIcon={isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            >
              {isPaused ? "Resume" : "Pause"}
            </JXButton>

            <JXButton
              variant="outlined"
              color="neutral"
              size="sm"
              loading={isLoadingLogs}
              onClick={() => void handleRefreshLogs()}
              startIcon={<RefreshCw className="w-3.5 h-3.5" />}
            >
              Refresh
            </JXButton>

            <JXButton
              variant="outlined"
              color="neutral"
              size="sm"
              onClick={handleCopyBuffer}
              startIcon={copiedBuffer ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            >
              {copiedBuffer ? "Copied" : "Copy Buffer"}
            </JXButton>

            <JXButton
              variant="outlined"
              color="neutral"
              size="sm"
              onClick={handleDownloadLog}
              startIcon={<Download className="w-3.5 h-3.5" />}
            >
              Download (.gz)
            </JXButton>

            <JXButton
              variant="soft"
              color="error"
              size="sm"
              onClick={handleFlushBuffer}
              startIcon={<Trash2 className="w-3.5 h-3.5" />}
            >
              Flush
            </JXButton>
          </div>
        </div>

        {logFetchError && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3">
            <div role="alert" className="min-w-0 flex-1 rounded-lg bg-rose-500/10 border border-rose-500/30 p-2.5 text-rose-300 text-xs font-mono">
              {logFetchError}
            </div>
            <JXButton variant="outlined" color="neutral" size="sm" onClick={() => void fetchServiceLogs()}>Retry</JXButton>
          </div>
        )}
      </JXCard>

      {/* Filter Ribbon */}
      <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
        <div className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Target Service Dropdown */}
            <select
              aria-label="Target log service"
              value={targetService}
              onChange={(e) => setTargetService(e.target.value)}
              className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] focus:outline-none"
            >
              <option value="ai-bridge-core.service">ai-bridge-core.service (control)</option>
              <option value="ai-bridge-mcp-gateway">ai-bridge-mcp-gateway (mcp)</option>
              <option value="ai-bridge-edge-daemon">ai-bridge-edge-daemon (oauth)</option>
              <option value="systemd-journald">systemd-journald (oauth)</option>
              <option value="nginx-tls-proxy">nginx-tls-proxy (nginx)</option>
              <option value="control">control</option>
              <option value="mcp">mcp</option>
              <option value="oauth">oauth</option>
              <option value="nginx">nginx</option>
            </select>

            {/* Buffer Size Selector */}
            <select
              aria-label="Log buffer size"
              value={bufferSize}
              onChange={(e) => setBufferSize(Number(e.target.value))}
              className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] focus:outline-none"
            >
              <option value={250}>Buffer: 250 lines</option>
              <option value={500}>Buffer: 500 lines</option>
              <option value={1000}>Buffer: 1000 lines</option>
            </select>

            {/* Auto-Scroll Toggle */}
            <div className="flex items-center gap-2 p-1.5 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)]">
              <span className="text-[var(--product-text-tertiary)]">Auto-Scroll</span>
              <JXSwitch label="Auto-scroll logs" checked={autoScroll} onChange={() => setAutoScroll(!autoScroll)} />
            </div>

            {/* Regex Query Input */}
            <div className="relative">
              <input
                type="text"
                id="logs-regex-filter"
                aria-label="Search logs by regex pattern"
                aria-invalid={Boolean(regexError)}
                aria-describedby={regexError ? "logs-regex-error" : undefined}
                placeholder="Regex search pattern, e.g. ERROR|WARN"
                value={regexQuery}
                onChange={(e) => setRegexQuery(e.target.value)}
                className="p-2 pr-16 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] placeholder:text-[var(--product-text-dim)] focus:outline-none w-64"
              />
              <span className="absolute right-2 top-2 px-1 rounded bg-[var(--product-raised)] text-[11px] text-indigo-400 font-bold">
                .* REGEX
              </span>
            </div>
          </div>

          {/* Log Level Pills */}
          <div className="flex items-center gap-1.5 p-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)]" role="group" aria-label="Filter by log level">
            {["ALL", "DEBUG", "INFO", "WARN", "ERROR"].map((lvl) => (
              <button
                key={lvl}
                type="button"
                aria-pressed={logLevelFilter === lvl}
                onClick={() => setLogLevelFilter(lvl)}
                className={`min-h-11 px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
                  logLevelFilter === lvl
                    ? "bg-indigo-600 text-white"
                    : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>
        </div>

        {regexError && (
          <p id="logs-regex-error" role="alert" className="px-4 pb-3 text-xs text-amber-300">{regexError}</p>
        )}

        {activeTraceFilter && (
          <div className="px-4 pb-3 flex items-center justify-between text-xs font-mono text-cyan-300">
            <span>Filtered by Distributed Trace ID: {activeTraceFilter}</span>
            <JXButton variant="text" color="neutral" size="sm" onClick={() => setActiveTraceFilter(null)}>
              Clear Trace Filter
            </JXButton>
          </div>
        )}
      </JXCard>

      {/* Main Split: Left 8 cols Monospace Log Canvas, Right 4 cols Structured JSON Inspector */}
      <JXGrid columns={12} gap="lg">
        {/* Monospace Log Canvas */}
        <JXGridItem colSpan={8}>
          <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
            <div className="p-3 bg-[var(--product-canvas)] border-b border-[var(--product-line)] flex items-center justify-between text-xs font-mono text-[var(--product-text-tertiary)]">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-indigo-400" />
                <span className="text-[var(--product-text-secondary)] font-bold">/var/log/ai-bridge/core.stdout.log (tail -f)</span>
              </div>
              <div className="flex items-center gap-3">
                <span>UTF-8</span>
                <span>PID 84019</span>
                <span className="flex items-center gap-1 text-emerald-400 font-bold">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  LIVE
                </span>
              </div>
            </div>

            <JXCardContent>
              <div className="p-3 space-y-1 font-mono text-xs max-h-[520px] overflow-y-auto leading-relaxed">
                {filteredLogs.length === 0 ? (
                  <EmptyState
                    variant="bare"
                    title={isLoadingLogs ? `Loading ${backendService} service logs…` : `No log records match the current filter (${backendService}).`}
                    description={isLoadingLogs ? undefined : "Try a different level, service, or regex — or clear the filters to see everything again."}
                    actionLabel={isLoadingLogs ? undefined : "Clear filters"}
                    onAction={isLoadingLogs ? undefined : handleFlushBuffer}
                  />
                ) : (
                  filteredLogs.map((log) => {
                    const isSelected = selectedEntry?.id === log.id;
                    // UX-29: timestamps go through useLanguage().date with
                    // an explicit timeZone (default: the user's local zone).
                    const logDate = new Date(log.timestamp);
                    const timeLabel = Number.isNaN(logDate.getTime())
                      ? log.timestamp.slice(11, 23)
                      : `${date(logDate, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}.${String(logDate.getMilliseconds()).padStart(3, "0")}`;
                    const levelStatus = log.level === "ERROR" || log.level === "FATAL" ? "error" : log.level === "WARN" ? "warning" : log.level === "INFO" ? "info" : "neutral";
                    return (
                      <div
                        key={log.id}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedEntry(log); }
                        }}
                        onClick={() => setSelectedEntry(log)}
                        className={`p-2 rounded-lg cursor-pointer transition-colors flex flex-wrap items-start gap-3 ${
                          isSelected
                            ? "bg-indigo-950/60 border border-indigo-500/60 text-[var(--product-text)]"
                            : "hover:bg-[var(--product-canvas)]/60 text-[var(--product-text-secondary)]"
                        }`}
                      >
                        <span className="text-[var(--product-text-tertiary)] text-[11px] shrink-0" title={Number.isNaN(logDate.getTime()) ? log.timestamp : date(logDate, { dateStyle: "medium", timeStyle: "medium" })}>{timeLabel}</span>
                        <span className="text-indigo-400 font-semibold shrink-0">[{log.workerThread}]</span>
                        <span className="text-cyan-400 font-semibold shrink-0">[{log.moduleTag}]</span>
                        <StatusBadge status={levelStatus} label={log.level} />
                        <span className="break-all">{log.message}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </JXCardContent>
          </JXCard>
        </JXGridItem>

        {/* Structured JSON Detail Inspection Drawer */}
        <JXGridItem colSpan={4}>
          <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
            <JXCardHeader
              title="Log details"
              icon={<FileCode className="w-5 h-5 text-indigo-400" />}
            />
            <JXCardContent>
              {selectedEntry ? (
                <div className="space-y-4 text-xs font-mono">
                  <div className="p-3 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-[var(--product-text-tertiary)]">Service:</span>
                      <span className="text-[var(--product-text-secondary)] font-semibold">{selectedEntry.service}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--product-text-tertiary)]">Worker PID:</span>
                      <span className="text-[var(--product-text-secondary)]">{selectedEntry.pid}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[var(--product-text-tertiary)]">Trace ID:</span>
                      <span className="text-cyan-400 font-bold">{selectedEntry.traceId}</span>
                    </div>
                  </div>

                  {/* Actions: Filter by Trace ID & Pin to Audit Trail */}
                  <div className="flex flex-wrap gap-2">
                    <JXButton
                      variant="soft"
                      color="primary"
                      size="sm"
                      onClick={() => setActiveTraceFilter(selectedEntry.traceId)}
                      startIcon={<Search className="w-3.5 h-3.5" />}
                    >
                      Filter by Trace ID
                    </JXButton>
                    <JXButton
                      variant="outlined"
                      color="neutral"
                      size="sm"
                      onClick={() => setCurrentView("audit-trail")}
                      startIcon={<Pin className="w-3.5 h-3.5" />}
                    >
                      Pin to Audit Trail
                    </JXButton>
                  </div>

                  {/* Formatted JSON Payload Attributes */}
                  <div className="space-y-1.5">
                    <span className="text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider block">
                      Parsed Structured Attributes
                    </span>
                    <pre className="p-3 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] text-[11px] text-[var(--product-text-secondary)] overflow-x-auto max-h-56 overflow-y-auto">
                      <code>{JSON.stringify(selectedEntry.details, null, 2)}</code>
                    </pre>
                  </div>

                </div>
              ) : (
                <EmptyState variant="bare" title="No log selected"
                  description="Select a log entry to see its service, worker, trace ID, and parsed attributes here." />
              )}
            </JXCardContent>
          </JXCard>
        </JXGridItem>
      </JXGrid>

    </div>
  );
};

export default DiagnosticsLogsView;

