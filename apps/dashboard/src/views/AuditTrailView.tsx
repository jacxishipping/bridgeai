/**
 * Append-Only Audit Trail (Screen 12)
 * Reconstructed with pure JXUI primitives, motion/react, and lucide-react.
 * ZERO inline styles. ZERO custom CSS.
 *
 * Verification (UX-01): "Check verification" calls GET /api/audit/verify
 * and renders the real result (valid/invalid, blocks checked, first bad
 * block if any). In demo mode there is no control plane to verify against,
 * so the check honestly reports verification as unavailable there. The
 * per-record modal reports the latest chain-verification result for the
 * session, or that the chain has not been verified in this session.
 * Retention (UX-01): POST /api/audit/retention (days query param,
 * server-clamped 30–3650) prunes ledger rows older than the given days.
 *
 * Deep links (UX-13): ?record=<blockNumber> in the hash selects and
 * scrolls to that record; opening a record writes it back.
 */

import React, { useState, useMemo, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useScrollShadow } from "../hooks/useScrollShadow";
import {
  GlassModal,
  JXCard,
  JXCardContent,
  JXButton,
  StatusBadge,
  EmptyState,
} from "../ui";
import {
  FileCheck,
  Download,
  XCircle,
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  FileJson,
  FileText,
  Hash,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { api, token, sessionToken, ApiError } from "../api";
import type { AuditVerifyResult } from "../api";
import { useDashboardStore } from "../state/dashboardStore";
import { pushNotice } from "../state/notices";
import { Freshness } from "../components/Freshness";
import { useLanguage } from "../i18n";
import type { AuditEvent } from "../types/dashboard";

const PAGE_SIZE = 50;

type VerificationNotice = {
  tone: "success" | "error" | "warning";
  text: string;
};

type DownloadNotice = {
  tone: "success" | "error";
  text: string;
};

export const AuditTrailView: React.FC = () => {
  const auditEvents = useDashboardStore((s) => s.auditEvents);
  const refreshLive = useDashboardStore((s) => s.refreshLive);
  const syncState = useDashboardStore((s) => s.getSyncState());
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const syncError = useDashboardStore((s) => s.syncError);
  const { date: formatAuditDate } = useLanguage();
  const isLive = typeof window !== "undefined" && Boolean(token() || sessionToken());
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const scrollShadow = useScrollShadow(tableScrollRef);

  // Verification state (UX-01): the real result of GET /api/audit/verify,
  // or null until the check has run in this session.
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [verification, setVerification] = useState<AuditVerifyResult | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<VerificationNotice | null>(null);

  // Retention state (UX-01).
  const [retentionDays, setRetentionDays] = useState<number>(365);
  const [isApplyingRetention, setIsApplyingRetention] = useState<boolean>(false);

  // Filters state
  const [actorSelect, setActorSelect] = useState<string>("all");
  const [actorText, setActorText] = useState<string>("");
  const [verdictFilter, setVerdictFilter] = useState<string>("all");
  const [deviceSearch, setDeviceSearch] = useState<string>("");
  const [hashSearch, setHashSearch] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  // Sorting (UX-37): Block # and Timestamp headers are sortable.
  const [sortKey, setSortKey] = useState<"block" | "timestamp">("block");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Pagination (UX-32).
  const [page, setPage] = useState<number>(0);

  // Cryptographic Verification Modal state
  const [selectedProofEvent, setSelectedProofEvent] = useState<AuditEvent | null>(null);

  // Exporter dropdown menu
  const [exportMenuOpen, setExportMenuOpen] = useState<boolean>(false);
  const [downloadNotice, setDownloadNotice] = useState<DownloadNotice | null>(null);
  // Set when a server export fails: offers the local export as an explicit
  // secondary choice instead of silently falling back (UX-32).
  const [failedExportFormat, setFailedExportFormat] = useState<"csv" | "jsonld" | "jsonl" | null>(null);

  // Actor options derived from the loaded records (UX-32), not hardcoded
  // demo identities.
  const distinctActors = useMemo(
    () => Array.from(new Set(auditEvents.map((ev) => ev.actor))).sort(),
    [auditEvents]
  );

  // Filtered ledger records
  const filteredRecords = useMemo(() => {
    const actorQuery = actorText.trim() || (actorSelect !== "all" ? actorSelect : "");
    const fromMs = fromDate ? new Date(`${fromDate}T00:00:00Z`).getTime() : null;
    const toMs = toDate ? new Date(`${toDate}T23:59:59.999Z`).getTime() : null;
    return auditEvents.filter((ev) => {
      if (actorQuery && !ev.actor.toLowerCase().includes(actorQuery.toLowerCase())) {
        return false;
      }
      if (verdictFilter !== "all" && ev.governanceVerdict !== verdictFilter) {
        return false;
      }
      if (deviceSearch && !ev.targetHost.toLowerCase().includes(deviceSearch.toLowerCase())) {
        return false;
      }
      if (hashSearch && !ev.sha256Hash.toLowerCase().includes(hashSearch.toLowerCase())) {
        return false;
      }
      const ts = Date.parse(ev.timestamp);
      if (fromMs !== null && (Number.isNaN(ts) || ts < fromMs)) {
        return false;
      }
      if (toMs !== null && (Number.isNaN(ts) || ts > toMs)) {
        return false;
      }
      return true;
    });
  }, [auditEvents, actorSelect, actorText, verdictFilter, deviceSearch, hashSearch, fromDate, toDate]);

  const sortedRecords = useMemo(() => {
    const sorted = [...filteredRecords];
    sorted.sort((a, b) => {
      const cmp =
        sortKey === "block"
          ? a.blockNumber - b.blockNumber
          : Date.parse(a.timestamp) - Date.parse(b.timestamp);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [filteredRecords, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sortedRecords.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedRecords = sortedRecords.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const pageStart = sortedRecords.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const pageEnd = Math.min(sortedRecords.length, (safePage + 1) * PAGE_SIZE);

  const hasActiveFilters =
    actorSelect !== "all" ||
    actorText.trim() !== "" ||
    verdictFilter !== "all" ||
    deviceSearch !== "" ||
    hashSearch !== "" ||
    fromDate !== "" ||
    toDate !== "";

  // Reset to the first page whenever the filters change (UX-32).
  useEffect(() => {
    setPage(0);
  }, [actorSelect, actorText, verdictFilter, deviceSearch, hashSearch, fromDate, toDate]);

  const clearFilters = () => {
    setActorSelect("all");
    setActorText("");
    setVerdictFilter("all");
    setDeviceSearch("");
    setHashSearch("");
    setFromDate("");
    setToDate("");
    setPage(0);
  };

  const toggleSort = (key: "block" | "timestamp") => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // Deep link (UX-13): read ?record=<blockNumber> from the hash and
  // select/scroll to that record; write it back when a record is opened.
  // Parsed locally with history.pushState so no shared routing code changes.
  const readRecordParam = (): string | null => {
    if (typeof window === "undefined") return null;
    const query = window.location.hash.split("?")[1] ?? "";
    return new URLSearchParams(query).get("record");
  };

  const writeRecordParam = (id: string | null) => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "#/audit-trail";
    const [path, query] = hash.split("?");
    const params = new URLSearchParams(query ?? "");
    if (id) params.set("record", id);
    else params.delete("record");
    const next = params.toString() ? `${path}?${params.toString()}` : path;
    if (next !== hash) window.history.pushState(null, "", next);
  };

  const openRecord = (rec: AuditEvent) => {
    setSelectedProofEvent(rec);
    writeRecordParam(String(rec.blockNumber));
  };

  const closeRecord = () => {
    setSelectedProofEvent(null);
    writeRecordParam(null);
  };

  useEffect(() => {
    const id = readRecordParam();
    if (!id || selectedProofEvent) return;
    const rec = auditEvents.find((ev) => String(ev.blockNumber) === id);
    if (rec) {
      setSelectedProofEvent(rec);
      requestAnimationFrame(() => {
        document.getElementById(`audit-row-${id}`)?.scrollIntoView({ block: "nearest" });
      });
    }
    // Runs when the ledger loads/changes so a deep-linked record resolves
    // once its row exists; the early return keeps an open modal untouched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditEvents]);

  // Format an RFC 3339 UTC timestamp through the app locale with an
  // explicit UTC time zone (UX-29). Falls back to the raw string when the
  // value does not parse.
  const formatTimestamp = (value: string): string => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return formatAuditDate(parsed, {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  };

  const handleVerifyIntegrity = async () => {
    setIsVerifying(true);
    try {
      if (!isLive) {
        // No control plane in demo mode, so there is nothing to verify
        // against — say so instead of fabricating a result.
        setVerificationNotice({
          tone: "warning",
          text: "Not verified — no cryptographic verification available in demo mode. Sign in to the control plane and run Check verification against the live ledger.",
        });
        return;
      }
      await refreshLive?.();
      const result = await api.verifyAudit();
      setVerification(result);
      if (result.ok) {
        setVerificationNotice({
          tone: "success",
          text: `Verified — audit chain intact. ${result.checked} blocks checked${result.legacy_rows > 0 ? `, including ${result.legacy_rows} legacy rows recognised as intact` : ""}.`,
        });
      } else {
        setVerificationNotice({
          tone: "error",
          text: `Verification failed — audit chain broken at block ${result.broken_at ?? "unknown"}. ${result.checked} blocks checked.`,
        });
      }
    } catch (err) {
      setVerificationNotice({
        tone: "error",
        text: `Verification check failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleApplyRetention = async () => {
    if (!isLive || isApplyingRetention) return;
    const days = Math.min(3650, Math.max(30, Math.trunc(retentionDays) || 365));
    setRetentionDays(days);
    setIsApplyingRetention(true);
    try {
      const result = await api.setAuditRetention(days);
      pushNotice({
        tone: "success",
        title: "Retention applied",
        message: `Ledger now keeps ${result.retention_days} days. ${result.deleted_count} record${result.deleted_count === 1 ? "" : "s"} older than that were deleted.`,
      });
      await refreshLive?.();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const detail = err instanceof Error ? err.message : "Unknown error";
      const reason =
        status === 409
          ? "The control plane requires a WORM/SIEM export before pruning, and none is configured — nothing was deleted."
          : status === 502
          ? "The control plane's pre-prune export failed — nothing was deleted."
          : detail;
      pushNotice({
        tone: "error",
        title: "Retention was not applied",
        message: reason,
      });
    } finally {
      setIsApplyingRetention(false);
    }
  };

  const downloadBlob = (content: string, type: string, filename: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Local export of the visible (filtered) records. Clearly labelled as
  // local — never presented as the server ledger (UX-32).
  const exportLocal = (format: "csv" | "jsonld" | "jsonl") => {
    if (filteredRecords.length === 0) {
      pushNotice({
        tone: "info",
        title: "Nothing to export",
        message: "No records match the current filters.",
      });
      return;
    }
    if (format === "csv") {
      const header = "Block,Timestamp,Actor,Action,TargetDevice,Verdict,Hash\n";
      const rows = filteredRecords
        .map(
          (r) =>
            `${r.blockNumber},${r.timestamp},${r.actor},${r.action},${r.targetHost},${r.governanceVerdict},${r.sha256Hash}`
        )
        .join("\n");
      downloadBlob(header + rows, "text/csv", `audit-ledger-${Date.now()}.csv`);
    } else {
      const payload = {
        "@context": "https://schema.org",
        type: "AuditReport",
        totalRecords: filteredRecords.length,
        timestamp: new Date().toISOString(),
        blocks: filteredRecords,
      };
      downloadBlob(
        JSON.stringify(payload, null, 2),
        "application/ld+json",
        `audit-report-${Date.now()}.${format}`
      );
    }
    setExportMenuOpen(false);
    setFailedExportFormat(null);
    setDownloadNotice({
      tone: "success",
      text: `Exported ${filteredRecords.length} visible (local) records in ${format.toUpperCase()} format — this is the filtered on-screen set, not a server export.`,
    });
    setTimeout(() => setDownloadNotice(null), 3500);
  };

  const handleExport = async (format: "csv" | "jsonld" | "jsonl") => {
    if (Boolean(token() || sessionToken())) {
      try {
        const serverExport = await api.exportAudit();
        const events: any[] = Array.isArray(serverExport?.events) ? serverExport.events : [];
        if (format === "csv") {
          const header = "ID,Timestamp,Actor,Tool,DeviceID,Decision,Args\n";
          const rows = events
            .map(
              (r) =>
                `${r.id ?? ""},${r.ts ?? ""},${r.actor ?? ""},${r.tool ?? ""},${r.device_id ?? ""},${r.decision ?? ""},${JSON.stringify(r.args_json ?? "")}`
            )
            .join("\n");
          downloadBlob(header + rows, "text/csv", `audit-ledger-${Date.now()}.csv`);
        } else {
          const jsonlContent =
            format === "jsonl" && events.length > 0
              ? events.map((ev) => JSON.stringify(ev)).join("\n")
              : JSON.stringify(serverExport, null, 2);
          downloadBlob(
            jsonlContent,
            format === "jsonl" ? "application/x-ndjson" : "application/ld+json",
            `audit-report-${Date.now()}.${format}`
          );
        }
        setExportMenuOpen(false);
        setFailedExportFormat(null);
        setDownloadNotice({
          tone: "success",
          text: `Exported ${serverExport?.count ?? events.length} live records from server in ${format.toUpperCase()} format.`,
        });
        setTimeout(() => setDownloadNotice(null), 3500);
        return;
      } catch (err) {
        // Do NOT silently fall back to a local export: a server export
        // failure must be visible, with the local export offered as an
        // explicit, clearly-labelled secondary choice (UX-18, UX-32).
        const detail = err instanceof Error ? err.message : "Unknown error";
        setFailedExportFormat(format);
        setDownloadNotice({
          tone: "error",
          text: `Server export failed: ${detail}. No file was downloaded. You can export the visible (local) records instead.`,
        });
        pushNotice({
          tone: "error",
          title: "Server export failed",
          message: `${detail}. No file was downloaded — use "Export visible (local) records instead" if a local copy of the filtered records is acceptable.`,
        });
        return;
      }
    }

    exportLocal(format);
  };

  const verdictBadge = (verdict: AuditEvent["governanceVerdict"]) => {
    switch (verdict) {
      case "human_approved":
        return <StatusBadge status="approved" label="Human-approved" />;
      case "auto_allowed":
        return <StatusBadge status="success" label="Auto-allowed" />;
      case "denied":
        return <StatusBadge status="denied" label="Denied" />;
      case "flagged":
        return <StatusBadge status="warning" label="Flagged" />;
    }
  };

  const verificationIcon =
    verificationNotice?.tone === "success" ? (
      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-px" aria-hidden="true" />
    ) : verificationNotice?.tone === "error" ? (
      <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-px" aria-hidden="true" />
    ) : (
      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-px" aria-hidden="true" />
    );
  const verificationClasses =
    verificationNotice?.tone === "success"
      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
      : verificationNotice?.tone === "error"
      ? "bg-rose-500/10 border-rose-500/30 text-rose-200"
      : "bg-amber-500/10 border-amber-500/30 text-amber-200";

  return (
    <div className="space-y-4">
      {/* Verification Action & Exporter */}
      <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
        <div className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <JXButton
              variant="contained"
              color="primary"
              size="md"
              loading={isVerifying}
              onClick={handleVerifyIntegrity}
              startIcon={<FileCheck className="w-4 h-4" />}
            >
              Check verification
            </JXButton>

            {/* Multi-Format Exporter Dropdown */}
            <div className="relative">
              <JXButton
                variant="outlined"
                color="neutral"
                size="md"
                disabled={!isLive && filteredRecords.length === 0}
                title={!isLive && filteredRecords.length === 0 ? "No records to export" : undefined}
                onClick={() => setExportMenuOpen(!exportMenuOpen)}
                startIcon={<Download className="w-4 h-4" />}
                endIcon={<ChevronDown className="w-3.5 h-3.5" />}
              >
                Export
              </JXButton>

              {exportMenuOpen && (
                <div className="absolute right-0 mt-2 w-56 rounded-xl bg-[var(--product-surface)] border border-[var(--product-line)] p-1.5 shadow-2xl z-30 space-y-1 font-mono text-xs">
                  <button
                    type="button"
                    onClick={() => handleExport("csv")}
                    className="w-full flex items-center gap-2.5 p-2 rounded-lg text-[var(--product-text-secondary)] hover:bg-[var(--product-raised)] text-left transition-colors"
                  >
                    <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                    <span>CSV</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExport("jsonld")}
                    className="w-full flex items-center gap-2.5 p-2 rounded-lg text-[var(--product-text-secondary)] hover:bg-[var(--product-raised)] text-left transition-colors"
                  >
                    <FileJson className="w-4 h-4 text-indigo-400" />
                    <span>JSON-LD</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExport("jsonl")}
                    className="w-full flex items-center gap-2.5 p-2 rounded-lg text-[var(--product-text-secondary)] hover:bg-[var(--product-raised)] text-left transition-colors"
                  >
                    <FileText className="w-4 h-4 text-cyan-400" />
                    <span>JSONL</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Sync freshness (UX-06): only when live-authenticated; demo
              sessions never sync. */}
          {isLive ? (
            <div className="flex flex-col items-start lg:items-end gap-1">
              <Freshness checkedAt={lastSyncAt} loading={syncState === "loading"} />
              {syncState === "error" && syncError && (
                <span role="alert" className="text-xs text-rose-300">
                  Sync failed: {syncError}
                </span>
              )}
            </div>
          ) : (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-200">
              Demo — simulated data
            </span>
          )}
        </div>

        {/* Retention control (UX-01). */}
        <div className="px-5 pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 text-xs font-mono">
            <label htmlFor="audit-retention-days" className="text-[var(--product-text-secondary)] shrink-0">
              Retention — prune records older than
            </label>
            <div className="flex items-center gap-2">
              <input
                id="audit-retention-days"
                type="number"
                min={30}
                max={3650}
                value={retentionDays}
                disabled={!isLive || isApplyingRetention}
                onChange={(e) => setRetentionDays(Number(e.target.value))}
                aria-label="Retention in days"
                className="w-24 p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] focus:outline-none"
              />
              <span className="text-[var(--product-text-tertiary)]">days</span>
              <JXButton
                variant="outlined"
                color="neutral"
                size="sm"
                loading={isApplyingRetention}
                disabled={!isLive}
                title={!isLive ? "Sign in to manage retention" : undefined}
                onClick={handleApplyRetention}
              >
                Apply
              </JXButton>
            </div>
            <span className="text-[var(--product-text-tertiary)]">
              {isLive
                ? "Server keeps 30–3650 days; older records are deleted."
                : "Sign in to manage retention on the control plane."}
            </span>
          </div>
        </div>

        {verificationNotice && (
          <div className="px-5 pb-4">
            <div
              role="status"
              className={`p-3 rounded-xl border flex items-start gap-2 text-xs font-mono ${verificationClasses}`}
            >
              {verificationIcon}
              <span>{verificationNotice.text}</span>
            </div>
          </div>
        )}

        {downloadNotice && (
          <div className="px-5 pb-4">
            <div
              role={downloadNotice.tone === "error" ? "alert" : "status"}
              className={`p-3 rounded-xl border text-xs font-mono ${
                downloadNotice.tone === "error"
                  ? "bg-rose-500/10 border-rose-500/30 text-rose-200"
                  : "bg-indigo-500/10 border-indigo-500/30 text-indigo-300"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span>{downloadNotice.text}</span>
                <button
                  type="button"
                  aria-label="Dismiss export notice"
                  onClick={() => {
                    setDownloadNotice(null);
                    setFailedExportFormat(null);
                  }}
                  className="text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)] shrink-0"
                >
                  <XCircle className="w-4 h-4" />
                </button>
              </div>
              {downloadNotice.tone === "error" && failedExportFormat && (
                <div className="mt-3">
                  <JXButton
                    variant="outlined"
                    color="neutral"
                    size="sm"
                    onClick={() => exportLocal(failedExportFormat)}
                  >
                    Export visible (local) records instead
                  </JXButton>
                </div>
              )}
            </div>
          </div>
        )}
      </JXCard>

      {/* Filter Ribbon & Immutable Data Grid */}
      <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
        <div className="p-4 border-b border-[var(--product-line)] flex flex-col gap-3 text-xs font-mono">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-1 sm:pb-0">
              <select
                aria-label="Filter audit verdicts"
                value={verdictFilter}
                onChange={(e) => setVerdictFilter(e.target.value)}
                className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] focus:outline-none shrink-0"
              >
                <option value="all">All Verdicts</option>
                <option value="auto_allowed">Auto-Allowed</option>
                <option value="human_approved">Human-Approved</option>
                <option value="denied">Denied</option>
              </select>

              <select
                aria-label="Filter audit actors"
                value={actorSelect}
                onChange={(e) => setActorSelect(e.target.value)}
                className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] focus:outline-none shrink-0"
              >
                <option value="all">All Actors</option>
                {distinctActors.map((actor) => (
                  <option key={actor} value={actor}>
                    {actor}
                  </option>
                ))}
              </select>

              <input
                type="text"
                aria-label="Filter by actor name"
                placeholder="Filter by actor..."
                value={actorText}
                onChange={(e) => setActorText(e.target.value)}
                className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] placeholder-[var(--product-text-dim)] focus:outline-none shrink-0"
              />

              <input
                type="text"
                aria-label="Search target device"
                placeholder="Search target device..."
                value={deviceSearch}
                onChange={(e) => setDeviceSearch(e.target.value)}
                className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] placeholder-[var(--product-text-dim)] focus:outline-none shrink-0"
              />

              <input
                type="text"
                aria-label="Filter by hash"
                placeholder="Filter by hash..."
                value={hashSearch}
                onChange={(e) => setHashSearch(e.target.value)}
                className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] placeholder-[var(--product-text-dim)] focus:outline-none shrink-0"
              />

              <input
                type="date"
                aria-label="Show records from date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] focus:outline-none shrink-0"
              />
              <input
                type="date"
                aria-label="Show records until date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] focus:outline-none shrink-0"
              />
            </div>

            {hasActiveFilters && (
              <JXButton variant="outlined" color="neutral" size="sm" onClick={clearFilters}>
                Clear filters
              </JXButton>
            )}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span className="text-[var(--product-text-tertiary)] shrink-0">
              Showing{" "}
              <strong className="text-[var(--product-text-secondary)]">
                {pageStart}–{pageEnd}
              </strong>{" "}
              of{" "}
              <strong className="text-[var(--product-text-secondary)]">{sortedRecords.length}</strong>{" "}
              matching records ·{" "}
              <strong className="text-[var(--product-text-secondary)]">{auditEvents.length}</strong>{" "}
              total in ledger
            </span>
            {pageCount > 1 && (
              <nav aria-label={`Audit records · Page ${safePage + 1} of ${pageCount}`} className="flex items-center gap-2 shrink-0">
                <JXButton
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                  startIcon={<ChevronLeft className="w-3.5 h-3.5" />}
                >
                  Previous
                </JXButton>
                <span className="text-[var(--product-text-tertiary)]">
                  Page {safePage + 1} of {pageCount}
                </span>
                <JXButton
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage(safePage + 1)}
                  endIcon={<ChevronRight className="w-3.5 h-3.5" />}
                >
                  Next
                </JXButton>
              </nav>
            )}
          </div>
        </div>

        <JXCardContent>
          {pagedRecords.length === 0 ? (
            <EmptyState
              variant="bare"
              demo={!isLive}
              title={auditEvents.length === 0 ? "No audit records yet" : "No audit records match these filters"}
              description={
                auditEvents.length === 0
                  ? "Audit records appear here once tasks run against the fleet."
                  : "Try widening the date range or clearing a filter."
              }
              actionLabel={hasActiveFilters ? "Clear filters" : undefined}
              onAction={hasActiveFilters ? clearFilters : undefined}
            />
          ) : (
            <div ref={tableScrollRef} tabIndex={0} role="region" aria-label="Audit trail records" className="overflow-x-auto scroll-shadow rounded-xl border border-[var(--product-line)]" data-scroll-left={scrollShadow.left} data-scroll-right={scrollShadow.right}>
              <table className="product-table-sticky-first w-full min-w-[720px] text-left text-xs border-collapse">
                <caption className="sr-only">
                  Audit trail records: block number, timestamp in UTC, actor, action, target device, verdict, SHA-256 digest and verification
                </caption>
                <thead>
                  <tr className="bg-[var(--product-canvas)] border-b border-[var(--product-line)] text-[var(--product-text-tertiary)] font-mono uppercase">
                    <th scope="col" aria-sort={sortKey === "block" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className="p-3">
                      <button type="button" onClick={() => toggleSort("block")} className="uppercase hover:text-[var(--product-text-secondary)]">
                        Block #{sortKey === "block" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                    <th scope="col" aria-sort={sortKey === "timestamp" ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className="p-3">
                      <button type="button" onClick={() => toggleSort("timestamp")} className="uppercase hover:text-[var(--product-text-secondary)]">
                        RFC 3339 Timestamp (UTC){sortKey === "timestamp" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                    <th scope="col" className="p-3">Actor Identity</th>
                    <th scope="col" className="p-3">Action / Tool</th>
                    <th scope="col" className="p-3">Target Device</th>
                    <th scope="col" className="p-3">Verdict</th>
                    <th scope="col" className="p-3">SHA-256 Digest</th>
                    <th scope="col" className="p-3 text-right">Verification</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--product-line)]/60 font-mono">
                  {pagedRecords.map((rec) => (
                    <tr key={rec.blockNumber} id={`audit-row-${rec.blockNumber}`} className="hover:bg-[var(--product-canvas)]/40 transition-colors">
                      <td className="p-3 font-bold text-indigo-400">
                        #{String(rec.blockNumber).padStart(8, "0")}
                      </td>
                      <td className="p-3 text-[var(--product-text-secondary)]" title={rec.timestamp}>
                        {formatTimestamp(rec.timestamp)}
                      </td>
                      <td className="p-3 text-[var(--product-text-secondary)]">{rec.actor}</td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)]">
                          {rec.action}
                        </span>
                      </td>
                      <td className="p-3 text-[var(--product-text-secondary)]">{rec.targetHost}</td>
                      <td className="p-3">{verdictBadge(rec.governanceVerdict)}</td>
                      <td className="p-3 text-[var(--product-text-tertiary)] text-[11px] truncate max-w-xs">
                        {rec.sha256Hash}
                      </td>
                      <td className="p-3 text-right">
                        <button
                          type="button"
                          onClick={() => openRecord(rec)}
                          className="px-2.5 py-1 rounded bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)] text-xs transition-colors"
                        >
                          View record
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </JXCardContent>
      </JXCard>

      {/* Cryptographic Verification Modal */}
      <AnimatePresence>
        {selectedProofEvent && (
          <GlassModal onClose={closeRecord} title="Audit record details">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="space-y-4"
            >
              <div className="flex items-center justify-between border-b border-[var(--product-line)] pb-3">
                <div className="flex items-center gap-2 text-[var(--product-text-secondary)] font-bold">
                  <Hash className="w-5 h-5" />
                  <span>Audit Record</span>
                </div>
                <button
                  type="button"
                  aria-label="Close record details"
                  onClick={closeRecord}
                  className="text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-3 text-xs font-mono">
                <div>
                  <span className="text-[var(--product-text-tertiary)] block mb-1">Block Sequence ID:</span>
                  <div className="p-2 rounded bg-[var(--product-canvas)] text-indigo-400 font-bold">
                    #{selectedProofEvent.blockNumber} (RFC 3339: {selectedProofEvent.timestamp})
                  </div>
                </div>

                <div>
                  <span className="text-[var(--product-text-tertiary)] block mb-1">Current Block Hash (Leaf Node):</span>
                  <div className="p-2 rounded bg-[var(--product-canvas)] text-emerald-300 break-all font-mono">
                    {selectedProofEvent.sha256Hash}
                  </div>
                </div>

                <div>
                  <span className="text-[var(--product-text-tertiary)] block mb-1">Previous Block Hash Link:</span>
                  <div className="p-2 rounded bg-[var(--product-canvas)] text-[var(--product-text-secondary)] break-all font-mono">
                    {selectedProofEvent.prevHash || "0x0000000000000000000000000000000000000000 (Genesis Root)"}
                  </div>
                </div>

                <div>
                  <span className="text-[var(--product-text-tertiary)] block mb-1">Payload Summary:</span>
                  <div className="p-2.5 rounded bg-[var(--product-canvas)] text-[var(--product-text-secondary)]">
                    {selectedProofEvent.payloadSummary}
                  </div>
                </div>

                {verification ? (
                  verification.ok ? (
                    <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>
                        Chain verified in this session — {verification.checked} blocks checked, intact. This record is part of that verified chain.
                      </span>
                    </div>
                  ) : (
                    <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-200 flex items-center gap-2">
                      <XCircle className="w-4 h-4" />
                      <span>
                        Chain verification failed — first broken block is {verification.broken_at ?? "unknown"}. Do not rely on this record until the chain is repaired.
                      </span>
                    </div>
                  )
                ) : (
                  <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    <span>
                      Not verified in this session — run Check verification to verify the audit chain. The hash above is the digest as recorded by the server.
                    </span>
                  </div>
                )}
              </div>

              <div className="flex justify-end pt-2">
                <JXButton
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  onClick={closeRecord}
                >
                  Close Proof
                </JXButton>
              </div>
            </motion.div>
          </GlassModal>
        )}
      </AnimatePresence>
    </div>
  );
};

export default AuditTrailView;
