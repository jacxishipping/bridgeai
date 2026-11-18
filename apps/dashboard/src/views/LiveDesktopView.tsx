/**
 * AI Bridge Enterprise Dashboard — Live Desktop Studio & Dual-Control (Screen 5)
 * Low-latency WebRTC desktop stream canvas with dual cursor HUD, operator takeover bar,
 * hotkey macros, telemetry HUD, and open windows manager.
 * Strict JXUI Primitives & Lucide Icons. ZERO inline styles.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  JXBox,
  JXStack,
  JXGrid,
  JXGridItem,
  JXCard,
  JXCardHeader,
  JXCardContent,
  JXBadge,
  JXButton,
  JXSelect,
  JXAlert,
  JXLinearProgress,
  ProductModePill,
  StatusBadge,
  EmptyState,
} from "../ui";
import { Freshness } from "../components/Freshness";
import { pushNotice } from "../state/notices";
import {
  Monitor,
  Mouse,
  Keyboard,
  ClipboardCopy,
  Maximize2,
  Minimize2,
  Camera,
  Crosshair,
  Shield,
  Activity,
  AlertTriangle,
  Radio,
  CheckCircle2,
  Terminal,
  Code,
  Layers,
  Cpu,
  Lock,
  Unlock,
  RefreshCw,
  Power,
  Zap,
  Volume2,
  VolumeX,
  Upload,
  Download,
  FileText,
  Folder,
  X,
} from "lucide-react";
import { useDashboardStore } from "../state/dashboardStore";
import { api, token, sessionToken } from "../api";
import { readRoute, updateRouteParams } from "../state/navigation";
import { PageEmpty } from "../components/PageEmpty";

function isLiveMode(): boolean {
  return typeof window !== "undefined" && Boolean(token() || sessionToken());
}

interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  is_primary?: boolean;
}

interface WindowItem {
  id: string;
  name: string;
  desc: string;
  icon: "terminal" | "code" | "docker" | "monitor";
  active: boolean;
  pid: number;
}

const INITIAL_WINDOWS: WindowItem[] = [
  { id: "win-1", name: "bash (active)", desc: "PID 1042", icon: "terminal", active: true, pid: 1042 },
  { id: "win-2", name: "VS Code Server", desc: "port 8080", icon: "code", active: false, pid: 2184 },
  { id: "win-3", name: "Docker Engine", desc: "3 containers", icon: "docker", active: false, pid: 1892 },
  { id: "win-4", name: "System Monitor", desc: "24% CPU", icon: "monitor", active: false, pid: 3410 },
];

export interface SomElement {
  id: number;
  label: string;
  type: string;
  bounds: [number, number, number, number];
  norm_x: number;
  norm_y: number;
  norm_width: number;
  norm_height: number;
  center_x: number;
  center_y: number;
  positionClass?: string;
}

export interface PendingAgentIntent {
  intent_id: string;
  action: string;
  target_label: string;
  x: number;
  y: number;
  risk_tier: string;
  countdown_ms: number;
  start_time_ms: number;
}

export interface RemoteFileItem {
  name: string;
  relative_path: string;
  full_path: string;
  size_bytes: number;
  modified_at: number;
}

export interface ActiveFileTransfer {
  transfer_id: string;
  filename: string;
  size: number;
  percent: number;
  received_bytes: number;
  speed_kbps: number;
  status: "uploading" | "verifying" | "completed" | "error";
  error?: string;
  direction: "upload" | "download";
}

const SOM_POSITION_PRESETS = [
  "left-[4%] top-[10%] w-[60%] h-[56%]",
  "left-[66%] top-[10%] w-[30%] h-[80%]",
  "left-[4%] top-[70%] w-[60%] h-[24%]",
  "left-[8%] top-[14%] w-[40%] h-[35%]",
  "left-[52%] top-[14%] w-[42%] h-[40%]",
  "left-[10%] top-[55%] w-[45%] h-[35%]",
  "left-[58%] top-[58%] w-[38%] h-[32%]",
  "left-[20%] top-[25%] w-[60%] h-[50%]",
];

export const LiveDesktopView: React.FC = () => {
  const devices = useDashboardStore((s) => s.devices);
  const selectedDeviceId = useDashboardStore((s) => s.selectedDeviceId);
  const setSelectedDeviceId = useDashboardStore((s) => s.setSelectedDeviceId);
  // UX-06: sync state for the header Freshness indicator (live only).
  const syncState = useDashboardStore((s) => s.getSyncState());
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const syncError = useDashboardStore((s) => s.syncError);
  // Never fall back to seed inventory when signed out — desktop actions require live mode.
  // UX-27: never fall back to the first fleet device either. A stale ?device=
  // id renders an explicit "Device not available" state below instead of
  // silently showing the wrong device.
  const selectedDevice = isLiveMode()
    ? devices.find((d) => d.id === selectedDeviceId)
    : undefined;

  // Control modes (maps to canonical session modes: view_only, human_control, ai_assisted).
  // Observer-first (UX-33): input forwarding stays off until the operator
  // explicitly chooses Takeover. The mode tabs are the Takeover action.
  const [controlMode, setControlMode] = useState<"observer" | "takeover">("observer");
  const [sessionMode, setSessionMode] = useState<"view_only" | "human_control" | "ai_assisted">("view_only");
  const [mouseLinked, setMouseLinked] = useState<boolean>(true);
  const [keyForwarded, setKeyForwarded] = useState<boolean>(true);
  const [clipboardSync, setClipboardSync] = useState<boolean>(true);
  const [scalingMode, setScalingMode] = useState<"fit" | "native" | "fill">("fit");
  const [somOverlay, setSomOverlay] = useState<boolean>(true);

  // Operator cursor coordinates
  const [operatorCoords, setOperatorCoords] = useState<{ x: number; y: number }>({ x: 610, y: 220 });
  const [recentMacroNotice, setRecentMacroNotice] = useState<string | null>(null);
  const [windowsList, setWindowsList] = useState<WindowItem[]>(() => (isLiveMode() ? [] : INITIAL_WINDOWS));
  const [activeWindowId, setActiveWindowId] = useState<string>("win-1");

  // WebRTC offer wait (UX-33): persistent "waiting for agent offer" state
  // with elapsed time + Cancel, instead of a silent ~15 s poll.
  const [offerWait, setOfferWait] = useState<{ sessionId: string } | null>(null);
  const [offerWaitElapsedSec, setOfferWaitElapsedSec] = useState<number>(0);
  const offerWaitCancelledRef = useRef<boolean>(false);
  // Persistent session-status line, shown until dismissed.
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  // Explanatory panel for "why no stream" (UX-33).
  const [streamHelpOpen, setStreamHelpOpen] = useState<boolean>(false);

  // Live desktop stream, WebRTC & monitor state
  const [liveFrameUrl, setLiveFrameUrl] = useState<string | null>(null);
  const [liveFrameMeta, setLiveFrameMeta] = useState<{
    width?: number;
    height?: number;
    timestamp?: number;
    error?: string;
    note?: string;
  } | null>(null);
  const [liveMonitors, setLiveMonitors] = useState<MonitorInfo[]>([]);
  const [selectedMonitorIndex, setSelectedMonitorIndex] = useState<number>(0);
  const [isStreamActive, setIsStreamActive] = useState<boolean>(true);
  const [webrtcSessionId, setWebrtcSessionId] = useState<string | null>(null);
  // UX-13: desktop-session deep link (?session=<id>). Sessions are
  // ephemeral: the id is written when a session starts, and on load the
  // control plane is asked whether it still knows the session.
  const [routeSessionId, setRouteSessionId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readRoute().session ?? null
  );
  const [sessionNotFound, setSessionNotFound] = useState<boolean>(false);
  const [webrtcConnected, setWebrtcConnected] = useState<boolean>(false);
  const [webrtcStats, setWebrtcStats] = useState<{
    fps: number;
    bitrateMbps: number;
    rttMs: number;
    droppedFrames: number;
    state: string;
  }>({
    fps: 0,
    bitrateMbps: 0,
    rttMs: 0,
    droppedFrames: 0,
    state: "idle",
  });

  const BITRATE_LADDER_KBPS = [5000, 3500, 2200, 1200, 600];
  const [abrMode, setAbrMode] = useState<"auto" | "5000" | "3500" | "2200" | "1200" | "600">("auto");
  const [targetBitrateKbps, setTargetBitrateKbps] = useState<number>(4500);
  const [pointerLockActive, setPointerLockActive] = useState<boolean>(false);
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
  const [somElements, setSomElements] = useState<SomElement[]>([]);
  const [pendingIntent, setPendingIntent] = useState<PendingAgentIntent | null>(null);
  const [countdownRemainingMs, setCountdownRemainingMs] = useState<number>(0);

  // Audio: mute toggle only; live remote-audio capture is not shipped (silent/opt-in placeholder).
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(true);
  const [desktopAudioOptIn, setDesktopAudioOptIn] = useState<boolean>(false);
  const [desktopAudioCaptureLive, setDesktopAudioCaptureLive] = useState<boolean>(false);

  // Bi-directional file transfer states (RTCDataChannel 64KB chunked)
  const [isDraggingFile, setIsDraggingFile] = useState<boolean>(false);
  const [fileDrawerOpen, setFileDrawerOpen] = useState<boolean>(false);
  const [activeTransfer, setActiveTransfer] = useState<ActiveFileTransfer | null>(null);
  const [recentTransfers, setRecentTransfers] = useState<RemoteFileItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const isMouseDownRef = useRef<boolean>(false);
  const virtualCursorRef = useRef<{ normX: number; normY: number }>({ normX: 0.5, normY: 0.5 });
  const consecutiveBadRef = useRef<number>(0);
  const consecutiveGoodRef = useRef<number>(0);
  const currentBitrateRef = useRef<number>(4500);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const inputDcRef = useRef<RTCDataChannel | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const prevBytesRef = useRef<{ bytes: number; ts: number }>({ bytes: 0, ts: 0 });
  const inputSeqRef = useRef<number>(1);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const webrtcConnectedRef = useRef<boolean>(false);
  const lastCoordUpdateRef = useRef<number>(0);
  const cleanupWebrtcRef = useRef<() => void>(() => {});

  webrtcConnectedRef.current = webrtcConnected;

  // Synchronize active WebRTC media stream onto video element across all state updates and renders
  useEffect(() => {
    const video = videoRef.current;
    if (video && mediaStreamRef.current) {
      if (video.srcObject !== mediaStreamRef.current) {
        video.srcObject = mediaStreamRef.current;
      }
      if (video.paused && webrtcConnected) {
        video.play().catch(() => {});
      }
    }
  });

  // UX-13: resolve the ?session= deep link. Live only: ask the control
  // plane whether it still knows the session. Known → the session is
  // shown in the session-status line; unknown → an explicit "Session not
  // available" state (sessions end, so a stale link is expected, not an
  // error). Skipped for the session this view already owns.
  useEffect(() => {
    if (!routeSessionId || !isLiveMode() || routeSessionId === webrtcSessionId) return;
    let cancelled = false;
    void api
      .getSessionV1(routeSessionId)
      .then((res: any) => {
        if (cancelled) return;
        if (res && typeof res === "object" && (res.session_id || res.id || res.status)) {
          setSessionNotFound(false);
          setSessionStatus(
            `Linked session ${routeSessionId}${res.status ? ` — ${res.status}` : ""}. Start the stream to attach to it.`
          );
        } else {
          setSessionNotFound(true);
        }
      })
      .catch(() => {
        if (!cancelled) setSessionNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [routeSessionId, webrtcSessionId]);

  const sendDataChannelEvent = useCallback((payload: Record<string, unknown>) => {
    const dc = inputDcRef.current;
    if (dc && dc.readyState === "open") {
      try {
        dc.send(
          JSON.stringify({
            ...payload,
            sequence: inputSeqRef.current++,
            timestamp_ms: Date.now(),
          })
        );
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  const releaseAllRemoteKeys = useCallback(() => {
    sendDataChannelEvent({ type: "release_all_keys" });
  }, [sendDataChannelEvent]);

  // Adaptive Bitrate dispatcher
  const applyBitrate = useCallback(
    (kbps: number, isAutoAdjust = false) => {
      currentBitrateRef.current = kbps;
      setTargetBitrateKbps(kbps);
      sendDataChannelEvent({
        action: "network_quality",
        bitrate_kbps: kbps,
      });
      if (webrtcSessionId && isLiveMode()) {
        void api.updateSessionQualityV1(webrtcSessionId, { bitrate_kbps: kbps }).catch(() => {});
      }
      if (isAutoAdjust) {
        setRecentMacroNotice(`Adaptive Bitrate adjusted target: ${(kbps / 1000).toFixed(1)} Mbps`);
        setTimeout(() => setRecentMacroNotice(null), 2500);
      }
    },
    [sendDataChannelEvent, webrtcSessionId]
  );

  // Monitor browser pointer lock state
  useEffect(() => {
    const handleLockChange = () => {
      const isLocked = document.pointerLockElement === canvasContainerRef.current;
      setPointerLockActive(isLocked);
    };
    document.addEventListener("pointerlockchange", handleLockChange);
    return () => document.removeEventListener("pointerlockchange", handleLockChange);
  }, []);

  // Global mouse handlers for continuous drag and pointer lock motion
  useEffect(() => {
    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (isMouseDownRef.current) {
        isMouseDownRef.current = false;
        if (controlMode === "takeover" && mouseLinked) {
          sendDataChannelEvent({
            type: "mouse_button",
            action: "up",
            button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
            normalized: true,
            x: virtualCursorRef.current.normX,
            y: virtualCursorRef.current.normY,
          });
        }
      }
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement && document.pointerLockElement === canvasContainerRef.current) {
        const sens = 0.0006;
        let nx = virtualCursorRef.current.normX + e.movementX * sens;
        let ny = virtualCursorRef.current.normY + e.movementY * sens;
        nx = Math.max(0, Math.min(1, nx));
        ny = Math.max(0, Math.min(1, ny));
        virtualCursorRef.current = { normX: nx, normY: ny };

        const x = Math.round(nx * 2560);
        const y = Math.round(ny * 1440);
        const now = performance.now();
        if (now - lastCoordUpdateRef.current > 66) {
          lastCoordUpdateRef.current = now;
          setOperatorCoords({ x, y });
        }

        if (controlMode === "takeover" && mouseLinked) {
          sendDataChannelEvent({
            type: "mouse_move",
            x: nx,
            y: ny,
            normalized: true,
            monitor_index: selectedMonitorIndex,
          });
        }
      }
    };

    window.addEventListener("mouseup", handleGlobalMouseUp);
    window.addEventListener("mousemove", handleGlobalMouseMove);
    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
      window.removeEventListener("mousemove", handleGlobalMouseMove);
    };
  }, [controlMode, mouseLinked, sendDataChannelEvent, selectedMonitorIndex]);

  // Veto active agent anticipation intent
  const handleVetoAction = useCallback(() => {
    if (!pendingIntent) return;
    sendDataChannelEvent({
      action: "veto_agent_action",
      intent_id: pendingIntent.intent_id,
      reason: "Operator manual override",
    });
    setPendingIntent(null);
    setRecentMacroNotice(`Intercepted & vetoed agent action: [${pendingIntent.target_label}]`);
    setTimeout(() => setRecentMacroNotice(null), 3000);
  }, [pendingIntent, sendDataChannelEvent]);

  // Global keydown veto listener for Space or Esc
  useEffect(() => {
    if (!pendingIntent) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "Escape") {
        e.preventDefault();
        handleVetoAction();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingIntent, handleVetoAction]);

  // Grace period countdown timer for pending agent intent
  useEffect(() => {
    if (!pendingIntent) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - pendingIntent.start_time_ms;
      const remaining = Math.max(0, pendingIntent.countdown_ms - elapsed);
      setCountdownRemainingMs(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        setPendingIntent(null);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [pendingIntent]);

  // Toggle Vision SoM and query real UI elements
  const toggleSomOverlay = useCallback(() => {
    const next = !somOverlay;
    setSomOverlay(next);
    if (next) {
      if (inputDcRef.current?.readyState === "open") {
        sendDataChannelEvent({ action: "som_query" });
      } else if (selectedDevice?.id && isLiveMode()) {
        api
          .getDeviceUiElementsV1(selectedDevice.id)
          .then((res) => {
            if (res && Array.isArray(res.elements)) {
              setSomElements(res.elements);
              setRecentMacroNotice(`Vision SoM synchronized with ${res.elements.length} interactive elements`);
              setTimeout(() => setRecentMacroNotice(null), 2500);
            }
          })
          .catch(() => {});
      }
    }
  }, [somOverlay, sendDataChannelEvent, selectedDevice?.id]);

  // Fetch list of files currently on remote device storage
  const fetchRemoteFiles = useCallback(async () => {
    if (inputDcRef.current?.readyState === "open") {
      sendDataChannelEvent({ action: "file_list" });
      return;
    }
    if (selectedDevice?.id) {
      try {
        const res = await api.listDeviceFilesV1(selectedDevice.id);
        if (res && Array.isArray(res.files)) {
          setRecentTransfers(res.files);
        }
      } catch {}
    }
  }, [sendDataChannelEvent, selectedDevice?.id]);

  // Start bi-directional chunked file transfer (WebRTC DataChannel 64KB or REST fallback)
  const startFileTransfer = useCallback(
    async (file: File) => {
      if (!file) return;
      const tid = `tx_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const chunkSize = 64 * 1024; // 64 KB
      const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

      setActiveTransfer({
        transfer_id: tid,
        filename: file.name,
        size: file.size,
        percent: 0,
        received_bytes: 0,
        speed_kbps: 0,
        status: "uploading",
        direction: "upload",
      });
      setFileDrawerOpen(true);
      setRecentMacroNotice(`Initiating file transfer: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

      const dc = inputDcRef.current;
      const isDcOpen = dc && dc.readyState === "open";

      try {
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256Hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

        if (isDcOpen) {
          sendDataChannelEvent({
            action: "file_start",
            transfer_id: tid,
            name: file.name,
            size: file.size,
            total_chunks: totalChunks,
          });

          const uint8 = new Uint8Array(buffer);
          const startTime = Date.now();

          for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunkSlice = uint8.subarray(start, end);

            let binary = "";
            for (let j = 0; j < chunkSlice.length; j++) {
              binary += String.fromCharCode(chunkSlice[j]);
            }
            const chunkB64 = btoa(binary);

            sendDataChannelEvent({
              action: "file_chunk",
              transfer_id: tid,
              index: i,
              chunk: chunkB64,
            });

            const elapsedSec = Math.max(0.001, (Date.now() - startTime) / 1000);
            const transferred = end;
            const pct = Math.round((transferred / Math.max(1, file.size)) * 100);
            const speed = Math.round((transferred / 1024) / elapsedSec);

            setActiveTransfer((prev) =>
              prev && prev.transfer_id === tid
                ? { ...prev, percent: pct, received_bytes: transferred, speed_kbps: speed }
                : prev
            );

            if (i % 4 === 0) {
              await new Promise((r) => setTimeout(r, 8));
            }
          }

          setActiveTransfer((prev) =>
            prev && prev.transfer_id === tid ? { ...prev, status: "verifying" } : prev
          );

          sendDataChannelEvent({
            action: "file_end",
            transfer_id: tid,
            sha256: sha256Hex,
          });
        } else if (selectedDevice?.id) {
          let binary = "";
          const uint8 = new Uint8Array(buffer);
          for (let j = 0; j < uint8.length; j++) {
            binary += String.fromCharCode(uint8[j]);
          }
          const b64 = btoa(binary);

          const res = await api.uploadDeviceFileV1(selectedDevice.id, file.name, b64, sha256Hex);
          if (res && res.ok) {
            setActiveTransfer((prev) =>
              prev && prev.transfer_id === tid
                ? { ...prev, percent: 100, status: "completed", speed_kbps: res.speed_kbps || 120 }
                : prev
            );
            setRecentMacroNotice(`Uploaded file ${file.name} successfully to the remote device`);
            setTimeout(() => setRecentMacroNotice(null), 3000);
            void fetchRemoteFiles();
          } else {
            throw new Error(res?.error || "Upload failed");
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        setActiveTransfer((prev) =>
          prev && prev.transfer_id === tid ? { ...prev, status: "error", error: errMsg } : prev
        );
        setRecentMacroNotice(`File transfer error: ${errMsg}`);
        setTimeout(() => setRecentMacroNotice(null), 3500);
      }
    },
    [sendDataChannelEvent, selectedDevice?.id, fetchRemoteFiles]
  );

  const requestFileDownload = useCallback(
    (fileItem: RemoteFileItem) => {
      setRecentMacroNotice(`Downloading ${fileItem.name} from the remote device...`);
      if (inputDcRef.current?.readyState === "open") {
        sendDataChannelEvent({ action: "file_download_request", path: fileItem.full_path });
      } else if (selectedDevice?.id) {
        void api
          .downloadDeviceFileV1(selectedDevice.id, fileItem.full_path)
          .then((res) => {
            if (res && res.content_b64) {
              const byteCharacters = atob(res.content_b64);
              const byteNumbers = new Array(byteCharacters.length);
              for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
              }
              const byteArray = new Uint8Array(byteNumbers);
              const blob = new Blob([byteArray], { type: "application/octet-stream" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = res.name || fileItem.name;
              a.click();
              URL.revokeObjectURL(url);
              setRecentMacroNotice(`Downloaded ${fileItem.name} successfully`);
              setTimeout(() => setRecentMacroNotice(null), 3000);
            }
          })
          .catch((err) => {
            setRecentMacroNotice(`Download error: ${err.message}`);
            setTimeout(() => setRecentMacroNotice(null), 3000);
          });
      }
    },
    [sendDataChannelEvent, selectedDevice?.id]
  );

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDraggingFile(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void startFileTransfer(e.dataTransfer.files[0]);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void startFileTransfer(e.target.files[0]);
    }
  };

  // Automatically release held keys on window blur or visibility loss
  useEffect(() => {
    const onBlur = () => releaseAllRemoteKeys();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [releaseAllRemoteKeys]);

  // Switch session mode (View Only, Human Control, AI-Assisted Control)
  const applySessionMode = useCallback(
    async (mode: "view_only" | "human_control" | "ai_assisted") => {
      setSessionMode(mode);
      setControlMode(mode === "view_only" ? "observer" : "takeover");
      if (mode === "view_only") {
        releaseAllRemoteKeys();
      }
      if (isLiveMode() && webrtcSessionId) {
        try {
          await api.setSessionModeV1(
            webrtcSessionId,
            mode,
            mode === "human_control"
          );
        } catch {
          // Ignore mode update network errors when session is local
        }
      }
    },
    [webrtcSessionId, releaseAllRemoteKeys]
  );

  // UX-11: Esc releases control. The veto window owns Esc only while a
  // pending agent intent exists (handled above); outside that window Esc
  // switches back to Observer mode and releases held keys, so Esc can
  // always release the session. Skipped inside open dialogs and text fields.
  useEffect(() => {
    if (controlMode !== "takeover" || pendingIntent) return;
    const handleEscapeRelease = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector("dialog[open]")) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest("input, textarea, select, [contenteditable]")) return;
      releaseAllRemoteKeys();
      void applySessionMode("view_only");
      setRecentMacroNotice("Released control — switched to Observer mode (Esc).");
      setTimeout(() => setRecentMacroNotice(null), 3000);
    };
    window.addEventListener("keydown", handleEscapeRelease);
    return () => window.removeEventListener("keydown", handleEscapeRelease);
  }, [controlMode, pendingIntent, applySessionMode, releaseAllRemoteKeys]);

  // Elapsed-time ticker for the offer wait (UX-33).
  useEffect(() => {
    if (!offerWait) return;
    const startedAt = Date.now();
    setOfferWaitElapsedSec(0);
    const interval = setInterval(() => {
      setOfferWaitElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [offerWait]);

  const handleSealSessionRecording = useCallback(async () => {
    const sid = webrtcSessionId || "session_active";
    if (!isLiveMode()) {
      // Demo mode: there is no real recording, so there is nothing to seal.
      // Label it simulated instead of showing a fabricated seal value.
      setRecentMacroNotice("Demo mode: recording seal is simulated — no real recording was sealed.");
      setTimeout(() => setRecentMacroNotice(null), 3500);
      return;
    }
    try {
      const existing = await api.getSessionRecordingV1(sid).catch(() => null);
      const res = await api.sealSessionRecordingV1(sid);
      if (res && res.ok) {
        setRecentMacroNotice(
          `Sealed session recording (${existing?.frame_count ?? 0} frames). Merkle leaf: ${res.merkle_leaf || "recorded"}`
        );
      } else {
        setRecentMacroNotice(res?.error || "Failed to seal session recording.");
      }
    } catch (err: any) {
      setRecentMacroNotice(`Seal recording failed: ${err?.message || "Unknown error"}`);
    }
    setTimeout(() => setRecentMacroNotice(null), 3500);
  }, [webrtcSessionId]);

  const fetchLiveFrame = useCallback(
    async (scale = 0.75, quality = 70) => {
      if (!isLiveMode() || !selectedDevice?.id || webrtcConnectedRef.current) return;
      try {
        const res = await api.desktopFrame(selectedDevice.id, scale, quality);
        if (webrtcConnectedRef.current) return;
        if (res && typeof res === "object" && res.base64_data) {
          const fmt = String(res.format || "jpeg").toLowerCase();
          setLiveFrameUrl(`data:image/${fmt};base64,${res.base64_data}`);
          setLiveFrameMeta({
            width: Number(res.width || 1920),
            height: Number(res.height || 1080),
            timestamp: Number(res.timestamp || Date.now() / 1000),
          });
        } else {
          setLiveFrameMeta({
            error: String(res?.error || ""),
            note: String(res?.note || "Desktop session not currently active or headless device."),
          });
        }
      } catch (err: any) {
        if (webrtcConnectedRef.current) return;
        setLiveFrameMeta({
          error: err?.message || "Unable to fetch desktop frame",
          note: "Check that the target device is online and desktop capture is enabled.",
        });
      }
    },
    [selectedDevice?.id]
  );

  // Load device monitors & poll desktop frames in live mode
  useEffect(() => {
    if (!isLiveMode() || !selectedDevice?.id) return;

    let cancelled = false;
    api
      .getDeviceMonitorsV1(selectedDevice.id)
      .catch(() => api.deviceMonitors(selectedDevice.id))
      .then((res) => {
        if (!cancelled && Array.isArray(res?.monitors)) {
          setLiveMonitors(res.monitors);
        }
      })
      .catch(() => {});

    if (selectedDevice.status === "online" || selectedDevice.id === "local") {
      if (!webrtcConnected) {
        void fetchLiveFrame(0.75, 70);
      }
    } else {
      setLiveFrameUrl(null);
      setLiveFrameMeta({
        note: `Device ${selectedDevice.hostname || selectedDevice.id} is currently ${selectedDevice.status}.`,
      });
    }

    if (!isStreamActive || (selectedDevice.status !== "online" && selectedDevice.id !== "local")) {
      return () => {
        cancelled = true;
      };
    }

    const timer = setInterval(() => {
      if (!cancelled && isLiveMode() && !webrtcConnectedRef.current) {
        void fetchLiveFrame(0.75, 70);
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedDevice?.id, selectedDevice?.status, selectedDevice?.hostname, isStreamActive, webrtcConnected, fetchLiveFrame]);

  // Mouse move handler over canvas (when not pointer-locked)
  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (document.pointerLockElement === canvasContainerRef.current) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      virtualCursorRef.current = { normX, normY };
      const x = Math.round(normX * 2560);
      const y = Math.round(normY * 1440);

      // Throttle HUD coordinate text re-renders to ~15 FPS to avoid 60-120 full React re-renders per second
      const now = performance.now();
      if (now - lastCoordUpdateRef.current > 66) {
        lastCoordUpdateRef.current = now;
        setOperatorCoords({ x, y });
      }

      if (controlMode === "takeover" && mouseLinked) {
        sendDataChannelEvent({
          type: "mouse_move",
          x: normX,
          y: normY,
          normalized: true,
          monitor_index: selectedMonitorIndex,
        });
      }
    },
    [controlMode, mouseLinked, sendDataChannelEvent, selectedMonitorIndex]
  );

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isLiveMode() || controlMode !== "takeover" || !mouseLinked) return;
      isMouseDownRef.current = true;
      const rect = e.currentTarget.getBoundingClientRect();
      const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      virtualCursorRef.current = { normX, normY };

      sendDataChannelEvent({
        type: "mouse_button",
        action: "down",
        button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
        x: normX,
        y: normY,
        normalized: true,
      });
    },
    [controlMode, mouseLinked, sendDataChannelEvent]
  );

  const handleCanvasMouseUp = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isLiveMode() || controlMode !== "takeover" || !mouseLinked) return;
      isMouseDownRef.current = false;
      const rect = e.currentTarget.getBoundingClientRect();
      const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      virtualCursorRef.current = { normX, normY };

      sendDataChannelEvent({
        type: "mouse_button",
        action: "up",
        button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left",
        x: normX,
        y: normY,
        normalized: true,
      });
    },
    [controlMode, mouseLinked, sendDataChannelEvent]
  );

  const togglePointerLock = useCallback(() => {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    } else if (canvasContainerRef.current) {
      canvasContainerRef.current.requestPointerLock();
    }
  }, []);

  // Forward canvas click in takeover mode when logged in
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isLiveMode() || controlMode !== "takeover" || !mouseLinked || !selectedDevice?.id) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      if (
        sendDataChannelEvent({
          type: "mouse_button",
          action: "click",
          button: "left",
          x: normX,
          y: normY,
          normalized: true,
        })
      ) {
        return;
      }
      // Only fallback to HTTP input if WebRTC data channel is completely disconnected
      if (!webrtcConnectedRef.current) {
        void api
          .sendDesktopInput(selectedDevice.id, {
            action: "click",
            x: normX,
            y: normY,
            normalized: true,
            button: "left",
            clicks: 1,
            screen_width: liveFrameMeta?.width || 1920,
            screen_height: liveFrameMeta?.height || 1080,
          })
          .catch(() => {});
      }
    },
    [controlMode, mouseLinked, selectedDevice?.id, liveFrameMeta?.width, liveFrameMeta?.height, sendDataChannelEvent]
  );

  // Forward keyboard events in takeover mode when logged in
  const handleCanvasKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // UX-11: Esc releases control — unless an agent-intent veto is pending,
      // in which case the global veto listener owns Esc. The release Esc is
      // never forwarded to the remote device.
      if (e.key === "Escape") {
        if (pendingIntent) return;
        if (controlMode === "takeover") {
          e.preventDefault();
          e.stopPropagation();
          releaseAllRemoteKeys();
          void applySessionMode("view_only");
          setRecentMacroNotice("Released control — switched to Observer mode (Esc).");
          setTimeout(() => setRecentMacroNotice(null), 3000);
          canvasContainerRef.current?.blur();
        }
        return;
      }
      if (!isLiveMode() || controlMode !== "takeover" || !keyForwarded || !selectedDevice?.id) return;
      if (
        sendDataChannelEvent({
          type: "key_event",
          action: "down",
          key: e.key,
          code: e.code,
          modifiers: {
            ctrl: e.ctrlKey,
            shift: e.shiftKey,
            alt: e.altKey,
            meta: e.metaKey,
          },
        })
      ) {
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        void api
          .sendDesktopInput(selectedDevice.id, {
            action: "type",
            text: e.key,
          })
          .catch(() => {});
      } else {
        void api
          .sendDesktopInput(selectedDevice.id, {
            action: "press",
            key: e.key.toLowerCase(),
          })
          .catch(() => {});
      }
    },
    [controlMode, keyForwarded, selectedDevice?.id, sendDataChannelEvent, pendingIntent, applySessionMode, releaseAllRemoteKeys]
  );

  const handleCanvasKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isLiveMode() || controlMode !== "takeover" || !keyForwarded) return;
      sendDataChannelEvent({
        type: "key_event",
        action: "up",
        key: e.key,
        code: e.code,
      });
    },
    [controlMode, keyForwarded, sendDataChannelEvent]
  );

  const dispatchMacro = (macroName: string) => {
    setRecentMacroNotice(`Dispatched macro [${macroName}] to target device ${selectedDevice?.hostname || "srv-us-east-412"}`);
    setTimeout(() => setRecentMacroNotice(null), 3000);

    if (isLiveMode() && selectedDevice?.id) {
      const macroKeyMap: Record<string, string> = {
        "Ctrl+Alt+Del": "ctrl+alt+delete",
        "Win / Super": "win",
        "Alt+Tab": "alt+tab",
        "Ctrl+Shift+Esc": "ctrl+shift+esc",
        "Unlock Screen": "enter",
      };
      const combo = macroKeyMap[macroName] || macroName.toLowerCase();
      void api
        .sendDesktopInput(selectedDevice.id, {
          action: "hotkey",
          key: combo,
        })
        .catch(() => {});
    }
  };

  // UX-08: capture a REAL PNG. The old handler only fetched a frame and
  // showed a notice claiming a "3840x2160 PNG" had been captured — no file
  // was ever produced. Now the current video frame (WebRTC) or the polled
  // fallback frame is drawn to a canvas and downloaded as a PNG. When no
  // frame is available at all, the notice says so honestly instead.
  const handleCaptureSnapshot = useCallback(() => {
    const downloadPng = (canvas: HTMLCanvasElement) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          pushNotice({
            tone: "error",
            title: "Snapshot failed",
            message: "Could not encode the desktop frame as a PNG.",
          });
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        a.href = url;
        a.download = `desktop-snapshot-${selectedDevice?.hostname || "device"}-${stamp}.png`;
        a.click();
        URL.revokeObjectURL(url);
        pushNotice({
          tone: "success",
          title: "Snapshot saved",
          message: `Downloaded ${a.download}.`,
        });
      }, "image/png");
    };

    const video = videoRef.current;
    if (webrtcConnected && video && video.videoWidth > 0 && video.videoHeight > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        downloadPng(canvas);
        return;
      }
    }

    if (liveFrameUrl) {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          pushNotice({ tone: "error", title: "Snapshot failed", message: "Could not encode the desktop frame as a PNG." });
          return;
        }
        ctx.drawImage(img, 0, 0);
        downloadPng(canvas);
      };
      img.onerror = () => {
        pushNotice({
          tone: "error",
          title: "Snapshot failed",
          message: "The last desktop frame could not be loaded for capture.",
        });
      };
      img.src = liveFrameUrl;
      return;
    }

    if (isLiveMode() && selectedDevice?.id) {
      void fetchLiveFrame(1.0, 85);
    }
    pushNotice({
      tone: "info",
      title: "Preview only — no frame to save",
      message: "No desktop frame is available yet, so no PNG was produced. Start the stream or wait for the next frame, then capture again.",
    });
  }, [webrtcConnected, liveFrameUrl, selectedDevice?.hostname, selectedDevice?.id, fetchLiveFrame]);

  const webrtcSessionIdRef = useRef<string | null>(null);
  webrtcSessionIdRef.current = webrtcSessionId;

  const cleanupWebrtc = useCallback(() => {
    const activeSid = webrtcSessionIdRef.current;
    if (activeSid && isLiveMode()) {
      void api.terminateSessionV1(activeSid).catch(() => {});
    }
    // UX-13: the session is over, so its deep link goes away with it —
    // including the component state, or the probe below would re-flag
    // the just-terminated session as "not available".
    updateRouteParams({ session: undefined });
    setRouteSessionId(null);
    setSessionNotFound(false);
    releaseAllRemoteKeys();
    mediaStreamRef.current = null;
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch {}
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // Ignore close errors
      }
      wsRef.current = null;
    }
    if (inputDcRef.current) {
      try {
        inputDcRef.current.close();
      } catch {
        // Ignore close errors
      }
      inputDcRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        // Ignore close errors
      }
      pcRef.current = null;
    }
    setWebrtcSessionId(null);
    setWebrtcConnected(false);
    setOfferWait(null);
    setSessionStatus(null);
  }, [releaseAllRemoteKeys]);

  cleanupWebrtcRef.current = cleanupWebrtc;

  // Poll RTCPeerConnection.getStats() for live FPS, bitrate, RTT, and dropped frames
  useEffect(() => {
    if (!webrtcSessionId) return;
    const interval = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let fps = 30;
        let droppedFrames = 0;
        let bytesReceived = 0;
        let rttMs = 12;
        report.forEach((stat: any) => {
          if (stat.type === "inbound-rtp" && stat.kind === "video") {
            if (typeof stat.framesPerSecond === "number") fps = Math.round(stat.framesPerSecond);
            if (typeof stat.framesDropped === "number") droppedFrames = stat.framesDropped;
            if (typeof stat.bytesReceived === "number") bytesReceived = stat.bytesReceived;
          }
          if (stat.type === "candidate-pair" && stat.state === "succeeded") {
            if (typeof stat.currentRoundTripTime === "number") {
              rttMs = Math.round(stat.currentRoundTripTime * 1000);
            }
          }
        });
        const now = performance.now();
        let bitrateMbps = 4.5;
        if (prevBytesRef.current.ts > 0 && bytesReceived > prevBytesRef.current.bytes) {
          const deltaSec = (now - prevBytesRef.current.ts) / 1000;
          if (deltaSec > 0) {
            bitrateMbps = Number(
              (((bytesReceived - prevBytesRef.current.bytes) * 8) / (deltaSec * 1_000_000)).toFixed(2)
            );
          }
        }
        prevBytesRef.current = { bytes: bytesReceived, ts: now };

        // Closed-loop Adaptive Bitrate (ABR) algorithm
        if (abrMode === "auto") {
          const curr = currentBitrateRef.current;
          const isCongested = rttMs > 160 || droppedFrames > 5;
          const isClear = rttMs < 90 && droppedFrames === 0;

          if (isCongested) {
            consecutiveGoodRef.current = 0;
            consecutiveBadRef.current += 1;
            if (consecutiveBadRef.current >= 2) {
              consecutiveBadRef.current = 0;
              const nextLower = BITRATE_LADDER_KBPS.find((r) => r < curr);
              if (nextLower) {
                applyBitrate(nextLower, true);
              }
            }
          } else if (isClear) {
            consecutiveBadRef.current = 0;
            consecutiveGoodRef.current += 1;
            if (consecutiveGoodRef.current >= 8) {
              consecutiveGoodRef.current = 0;
              const reversed = [...BITRATE_LADDER_KBPS].reverse();
              const nextHigher = reversed.find((r) => r > curr);
              if (nextHigher) {
                applyBitrate(nextHigher, true);
              }
            }
          } else {
            consecutiveBadRef.current = 0;
            consecutiveGoodRef.current = 0;
          }
        }

        if (inputDcRef.current?.readyState === "open" && (rttMs > 160 || droppedFrames > 5)) {
          sendDataChannelEvent({
            action: "network_quality",
            rtt_ms: rttMs,
            packet_loss_pct: Math.min(100, Math.round((droppedFrames / Math.max(1, droppedFrames + fps)) * 100)),
          });
        }
        setWebrtcStats({
          fps,
          bitrateMbps,
          rttMs,
          droppedFrames,
          state: pc.connectionState || "connected",
        });
      } catch {
        // Ignore getStats errors
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [webrtcSessionId, abrMode, applyBitrate]);

  // Only teardown WebRTC when LiveDesktopView component actually unmounts
  useEffect(() => {
    return () => {
      cleanupWebrtcRef.current();
    };
  }, []);

  // UX-33: cancel a pending offer wait. Terminates the session server-side
  // and stops the poll loop via offerWaitCancelledRef.
  const handleCancelOfferWait = useCallback(() => {
    offerWaitCancelledRef.current = true;
    setOfferWait(null);
    setSessionStatus(null);
    cleanupWebrtc();
  }, [cleanupWebrtc]);

  const handleStartWebrtc = async () => {
    if (!isLiveMode() || !selectedDevice?.id) {
      setRecentMacroNotice("WebRTC signaling active in live control plane mode");
      setTimeout(() => setRecentMacroNotice(null), 2500);
      return;
    }
    if (String(selectedDevice.platform || "").toLowerCase() !== "windows") {
      setRecentMacroNotice(
        `Live Desktop WebRTC streaming is Windows-only. Selected device platform is “${selectedDevice.platform || "unknown"}”.`
      );
      setTimeout(() => setRecentMacroNotice(null), 4000);
      return;
    }
    cleanupWebrtc();
    setOfferWait(null);
    offerWaitCancelledRef.current = false;
    try {
      const sess = await api.createSessionV1({
        device_id: selectedDevice.id,
        mode: sessionMode,
        fps: 30,
        scale: 1.0,
        monitor_index: selectedMonitorIndex,
      });
      if (sess?.session_id) {
        const sid = String(sess.session_id);
        setWebrtcSessionId(sid);
        // UX-13: the running session is linkable (?session=<id>).
        setRouteSessionId(sid);
        setSessionNotFound(false);
        updateRouteParams({ session: sid });
        setSessionStatus(`Session ${sid} — created, waiting for agent offer…`);
        setRecentMacroNotice(`WebRTC session [${sid}] initialized (${sess.status || "waiting"})`);
        setTimeout(() => setRecentMacroNotice(null), 3000);

        let currentSess = sess;
        let offerSdp: string | undefined =
          currentSess.offer_sdp || currentSess.offer?.sdp;
        let offerType: string =
          currentSess.offer_type || currentSess.offer?.type || "offer";

        // If the remote Windows Agent is generating the SDP offer asynchronously, poll until it arrives
        if (!offerSdp) {
          setOfferWait({ sessionId: sid });
        }
        for (let attempt = 0; attempt < 30 && !offerSdp && !offerWaitCancelledRef.current; ++attempt) {
          await new Promise((r) => setTimeout(r, 500));
          if (offerWaitCancelledRef.current) break;
          try {
            const polled = await api.getSessionV1(sid);
            if (polled) {
              currentSess = polled;
              offerSdp = polled.offer_sdp || polled.offer?.sdp;
              offerType = polled.offer_type || polled.offer?.type || "offer";
              if (polled.status === "error" || polled.status === "ended") {
                break;
              }
            }
          } catch {
            // Continue polling
          }
        }
        setOfferWait(null);

        // UX-33: poll exhaustion is a sticky error, not silence. The notice
        // persists (error tone) and the session-status line keeps the id.
        if (!offerSdp) {
          if (offerWaitCancelledRef.current) {
            setSessionStatus(null);
            return;
          }
          pushNotice({
            tone: "error",
            title: "Agent did not answer",
            message: `Session ${sid}: no desktop offer arrived after 15 s. Check that the device is online and its agent is running, then choose Start stream again.`,
          });
          setSessionStatus(`Session ${sid} — no offer received. Agent did not answer after 15 s.`);
          return;
        }

        if (typeof RTCPeerConnection !== "undefined" && offerSdp) {
          let resolvedIceServers = Array.isArray(currentSess.ice_servers) ? currentSess.ice_servers : null;
          if (!resolvedIceServers) {
            const iceRes = await api.getIceServersV1().catch(() => null);
            if (Array.isArray(iceRes?.ice_servers)) {
              resolvedIceServers = iceRes.ice_servers;
            }
          }
          const pc = new RTCPeerConnection({
            iceServers: resolvedIceServers || [{ urls: "stun:stun.l.google.com:19302" }],
          });
          pcRef.current = pc;

          const setupDc = (channel: RTCDataChannel) => {
            inputDcRef.current = channel;
            channel.onopen = () => {
              if (somOverlay) {
                try {
                  channel.send(JSON.stringify({ action: "som_query" }));
                } catch {}
              }
            };
            channel.onmessage = (event) => {
              try {
                const data = JSON.parse(event.data);
                if (data.type === "clipboard_data" && data.text) {
                  void navigator.clipboard?.writeText(data.text).catch(() => {});
                  setRecentMacroNotice(`Synced clipboard from remote (${data.text.length} chars)`);
                  setTimeout(() => setRecentMacroNotice(null), 3000);
                }
                if (data.type === "som_elements" && Array.isArray(data.elements)) {
                  setSomElements(data.elements);
                  setRecentMacroNotice(`Vision SoM synchronized with ${data.elements.length} interactive targets`);
                  setTimeout(() => setRecentMacroNotice(null), 2500);
                }
                if (data.type === "agent_intent") {
                  setPendingIntent({
                    intent_id: String(data.intent_id || "intent_1"),
                    action: String(data.action || "click"),
                    target_label: String(data.target_label || "Autonomous Action"),
                    x: Number(data.x ?? 0.58),
                    y: Number(data.y ?? 0.38),
                    risk_tier: String(data.risk_tier || "tier2_workspace"),
                    countdown_ms: Number(data.countdown_ms || 3000),
                    start_time_ms: Date.now(),
                  });
                  setCountdownRemainingMs(Number(data.countdown_ms || 3000));
                }
                if (data.type === "agent_action_vetoed") {
                  setPendingIntent(null);
                  setRecentMacroNotice(`Vetoed agent action [${data.intent_id}]: ${data.reason || "Interception successful"}`);
                  setTimeout(() => setRecentMacroNotice(null), 3000);
                }
                if (data.type === "file_transfer_progress") {
                  setActiveTransfer((prev) =>
                    prev && prev.transfer_id === data.transfer_id
                      ? {
                          ...prev,
                          percent: Number(data.percent || 0),
                          received_bytes: Number(data.received_bytes || 0),
                        }
                      : prev
                  );
                }
                if (data.type === "file_transfer_complete") {
                  setActiveTransfer((prev) =>
                    prev && prev.transfer_id === data.transfer_id
                      ? {
                          ...prev,
                          percent: 100,
                          status: "completed",
                          speed_kbps: Number(data.speed_kbps || prev.speed_kbps),
                        }
                      : prev
                  );
                  setRecentMacroNotice(`Transferred ${data.filename} (${data.file_size} bytes) to the remote device`);
                  setTimeout(() => setRecentMacroNotice(null), 3500);
                  void fetchRemoteFiles();
                }
                if (data.type === "file_transfer_error") {
                  setActiveTransfer((prev) =>
                    prev && prev.transfer_id === data.transfer_id
                      ? { ...prev, status: "error", error: String(data.error || "Transfer failed") }
                      : prev
                  );
                }
                if (data.type === "file_list_result" && Array.isArray(data.files)) {
                  setRecentTransfers(data.files);
                }
                if (data.type === "file_download_complete") {
                  setRecentMacroNotice(`Remote file transfer download completed [${data.transfer_id}]`);
                  setTimeout(() => setRecentMacroNotice(null), 3000);
                }
              } catch {}
            };
          };

          const dc = pc.createDataChannel("input", { ordered: true });
          setupDc(dc);
          pc.ondatachannel = (e) => setupDc(e.channel);

          pc.ontrack = (event) => {
            if (event.streams && event.streams[0]) {
              mediaStreamRef.current = event.streams[0];
              if (videoRef.current) {
                videoRef.current.srcObject = event.streams[0];
                videoRef.current.play().catch(() => {});
              }
              setWebrtcConnected(true);
            }
          };

          pc.onicecandidate = (event) => {
            if (event.candidate) {
              void api.postIceV1(sid, event.candidate.toJSON()).catch(() => {});
            }
          };

          pc.onconnectionstatechange = () => {
            const st = pc.connectionState;
            setWebrtcStats((prev) => ({ ...prev, state: st }));
            if (st === "connected") {
              setIsReconnecting(false);
              setWebrtcConnected(true);
              setSessionStatus(`Session ${sid} — connected.`);
              setRecentMacroNotice(`WebRTC live H.264 stream connected [${sid.slice(0, 8)}]`);
              setTimeout(() => setRecentMacroNotice(null), 3000);
            } else if (st === "disconnected") {
              // Graceful network jitter handling: give ICE 2.5s to self-heal
              setIsReconnecting(true);
              setTimeout(() => {
                if (pcRef.current?.connectionState === "disconnected" || pcRef.current?.connectionState === "failed") {
                  setIsReconnecting(false);
                  setWebrtcConnected(false);
                  releaseAllRemoteKeys();
                  if (isLiveMode()) {
                    void handleStartWebrtc();
                  }
                } else if (pcRef.current?.connectionState === "connected") {
                  setIsReconnecting(false);
                }
              }, 2500);
            } else if (st === "failed") {
              setIsReconnecting(false);
              setWebrtcConnected(false);
              releaseAllRemoteKeys();
              setTimeout(() => {
                if (isLiveMode()) {
                  void handleStartWebrtc();
                }
              }, 1500);
            }
          };

          await pc.setRemoteDescription({
            type: offerType as RTCSdpType,
            sdp: offerSdp,
          });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (answer.sdp) {
            await api.postAnswerV1(sid, answer.sdp, answer.type || "answer");
          }

          try {
            // D-08: mint a single-use stream ticket for this session and
            // pass it in the WS URL. No long-lived token goes in the URL;
            // if minting fails the WS channel is skipped (the data
            // channel still carries input) and the notice below explains.
            const { ticket } = await api.mintStreamTicket(selectedDevice.id, sid);
            const ws = new WebSocket(api.sessionWebSocketUrl(sid, ticket));
            wsRef.current = ws;
          } catch {
            // Optional WebSocket signaling channel fallback
            setRecentMacroNotice("Live signalling channel unavailable (stream ticket could not be minted)");
            setTimeout(() => setRecentMacroNotice(null), 3000);
          }
        }
      }
    } catch (err: any) {
      setOfferWait(null);
      const message = err?.message || "Could not start WebRTC session";
      pushNotice({ tone: "error", title: "Could not start WebRTC session", message });
      setSessionStatus(`Session start failed — ${message}`);
      setRecentMacroNotice(message);
      setTimeout(() => setRecentMacroNotice(null), 3000);
    }
  };

  const handleSwitchMonitor = (idx: number) => {
    setSelectedMonitorIndex(idx);
    sendDataChannelEvent({ action: "switch_monitor", monitor_index: idx });
    if (webrtcSessionId && isLiveMode()) {
      void api.updateSessionQualityV1(webrtcSessionId, { monitor_index: idx }).catch(() => {});
    }
  };

  const handleSyncClipboard = async () => {
    setClipboardSync((prev) => !prev);
    try {
      const text = await navigator.clipboard?.readText();
      if (text) {
        sendDataChannelEvent({ action: "clipboard_sync", direction: "set", text });
        if (webrtcSessionId && isLiveMode()) {
          void api.syncSessionClipboardV1(webrtcSessionId, "set", text).catch(() => {});
        }
        setRecentMacroNotice(`Pushed clipboard (${text.length} chars) to remote`);
        setTimeout(() => setRecentMacroNotice(null), 3000);
        return;
      }
    } catch {}
    sendDataChannelEvent({ action: "clipboard_sync", direction: "get" });
    if (webrtcSessionId && isLiveMode()) {
      void api.syncSessionClipboardV1(webrtcSessionId, "get").catch(() => {});
    }
    setRecentMacroNotice("Requested clipboard from remote");
    setTimeout(() => setRecentMacroNotice(null), 3000);
  };

  const focusWindow = (id: string) => {
    setActiveWindowId(id);
    setWindowsList((prev) =>
      prev.map((w) => ({
        ...w,
        active: w.id === id,
      }))
    );
    const win = windowsList.find((w) => w.id === id);
    if (win) {
      setRecentMacroNotice(`Brought window [${win.name}] to foreground (PID ${win.pid})`);
      setTimeout(() => setRecentMacroNotice(null), 2500);
    }
  };

  const activeWindow = windowsList.find((w) => w.id === activeWindowId) || windowsList[0];
  const live = isLiveMode();
  const navigate = useDashboardStore((s) => s.setCurrentView);
  const liveDevices = live ? devices : [];
  // UX-27: no fallback to the first fleet device. A requested id with no
  // match renders the "Device not available" state below.
  const desktopDevice = live
    ? liveDevices.find((d) => d.id === selectedDeviceId)
    : undefined;
  const deviceNotAvailable = Boolean(
    live && liveDevices.length > 0 && selectedDeviceId && !desktopDevice
  );
  // WebRTC desktop stream / SoM / WASAPI overlays apply to Windows devices only.
  const isWindowsStreamHost = Boolean(
    desktopDevice && String(desktopDevice.platform || "").toLowerCase() === "windows"
  );
  const streamUnavailableReason = desktopDevice
    ? isWindowsStreamHost
      ? null
      : `Live Desktop WebRTC streaming is Windows-only. Selected device reports platform “${desktopDevice.platform || "unknown"}” (${desktopDevice.osRelease || "OS not reported"}).`
    : null;

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void api
      .desktopCapabilities()
      .then((caps: any) => {
        if (cancelled) return;
        const audio = caps?.desktop_audio || {};
        setDesktopAudioOptIn(Boolean(audio.opt_in));
        setDesktopAudioCaptureLive(Boolean(audio.capture_implemented));
      })
      .catch(() => {
        if (cancelled) return;
        setDesktopAudioOptIn(false);
        setDesktopAudioCaptureLive(false);
      });
    return () => {
      cancelled = true;
    };
  }, [live]);

  // UX-25: plain-language audio state. Desktop audio is not shipped in
  // this build, so the tooltip says so instead of naming the audio stack
  // or the environment variable that would enable it.
  const audioHonestyTitle = desktopAudioCaptureLive
    ? isAudioMuted
      ? "Unmute remote device audio"
      : "Mute remote device audio"
    : desktopAudioOptIn
      ? "Desktop audio is not available in this build — audio stays silent even when unmuted"
      : "Desktop audio is not available in this build";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-[var(--product-text)]">Live desktop</h1>
          <ProductModePill live={live} detail={live ? "WebRTC control" : "Preview only"} />
        </div>
        {live && (
          <div className="flex flex-wrap items-center gap-3">
            <Freshness checkedAt={lastSyncAt} loading={syncState === "loading"} />
            {syncState === "error" && syncError && (
              <span role="alert" className="text-xs text-rose-300">
                {syncError}
              </span>
            )}
            <StatusBadge
              status={webrtcConnected ? "online" : "idle"}
              label={webrtcConnected ? "Stream connected" : "No stream"}
            />
          </div>
        )}
      </header>

      {/* UX-39: in-page section nav. Buttons + scrollIntoView (not hash
          anchors — a hash change would trip the dashboard router). */}
      <nav aria-label="Desktop studio sections" className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono uppercase tracking-wider text-[var(--product-text-tertiary)]">Sections:</span>
        {(
          [
            ["studio-controls", "Controls"],
            ["desktop-stream", "Desktop stream"],
            ["file-transfer", "File transfer"],
            ["windows", "Windows"],
          ] as Array<[string, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() =>
              document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            className="px-2.5 py-1.5 min-h-11 sm:min-h-0 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)] hover:text-[var(--product-text)] transition-colors"
          >
            {label}
          </button>
        ))}
      </nav>

      {!live && (
        <PageEmpty
          demo
          title="Desktop streaming requires a connected control plane"
          description="Sign in to stream a real enrolled device. Demo mode does not open WebRTC or send input to devices."
          actionLabel="Connect server"
          onAction={() => navigate("login")}
          secondaryLabel="Open Live home"
          onSecondary={() => navigate("live")}
        />
      )}

      {live && liveDevices.length === 0 && (
        <PageEmpty
          title="No devices available to stream"
          description="Enroll an agent and wait for the first heartbeat before starting a desktop session."
          actionLabel="Enroll a device"
          onAction={() => navigate("devices")}
        />
      )}

      {/* UX-27: the requested device id matches nothing in the fleet — say so
          explicitly instead of showing the first device's desktop. */}
      {deviceNotAvailable && (
        <EmptyState
          variant="card"
          title="Device not available"
          description={`The device “${selectedDeviceId}” is not in the current fleet. The link may be stale, or the device may have been removed.`}
          actionLabel="Open fleet inventory"
          onAction={() => navigate("devices")}
          secondaryLabel="Use first available device"
          onSecondary={() => setSelectedDeviceId(liveDevices[0].id)}
        />
      )}

      {live && desktopDevice && !isWindowsStreamHost && (
        <JXAlert
          severity="warning"
          title="Desktop stream unavailable on this device"
          description={
            streamUnavailableReason ||
            "Select a Windows device. Linux and macOS agents do not expose a WebRTC desktop track."
          }
        />
      )}

      {/* UX-13: the linked session id is unknown to the control plane —
          say so explicitly; sessions end, so a stale link is expected. */}
      {sessionNotFound && (
        <EmptyState
          variant="card"
          title="Session not available"
          description={`The desktop session “${routeSessionId}” is not known to the control plane. It may have ended, or the link may be stale.`}
          actionLabel="Start a new session"
          onAction={() => {
            setRouteSessionId(null);
            setSessionNotFound(false);
            updateRouteParams({ session: undefined });
            document.getElementById("desktop-stream")?.scrollIntoView({ block: "start" });
          }}
        />
      )}

      {/* The studio below only renders for a real, matched device (UX-27). */}
      {!deviceNotAvailable && (
        <>
      {/* Top Header & Breadcrumb Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-[var(--product-line)]">
        <div className="flex items-center gap-3">
          <div className="w-full sm:w-72">
            <JXSelect
              options={(live ? liveDevices : []).map((d) => ({
                id: d.id,
                label: `${d.hostname} (${d.name})${String(d.platform || "").toLowerCase() === "windows" ? "" : " · no stream"}`,
              }))}
              value={desktopDevice?.id || selectedDevice?.id || ""}
              onChange={(val) => setSelectedDeviceId(val)}
              searchable
              label="Device"
            />
          </div>
          {liveMonitors.length > 0 && (
            <div className="flex items-center gap-1.5 font-mono text-xs">
              {liveMonitors.map((mon) => (
                <JXButton
                  key={mon.index}
                  size="sm"
                  color={selectedMonitorIndex === mon.index ? "primary" : "neutral"}
                  variant={selectedMonitorIndex === mon.index ? "contained" : "outlined"}
                  aria-pressed={selectedMonitorIndex === mon.index}
                  onClick={() => handleSwitchMonitor(mon.index)}
                >
                  {mon.name || `Display ${mon.index}`} ({mon.width}×{mon.height})
                </JXButton>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-xs">
          <div className="hidden lg:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-[var(--product-text-secondary)]">
            <StatusBadge
              status={webrtcConnected ? "running" : "idle"}
              label={webrtcConnected ? `H.264 ${webrtcStats.fps} FPS` : "Stream idle"}
            />
            <span className="text-[var(--product-text-dim)]">|</span>
            <JXButton
              size="sm"
              color="neutral"
              variant="text"
              onClick={() => {
                const modes: Array<"auto" | "5000" | "3500" | "2200" | "1200" | "600"> = [
                  "auto",
                  "5000",
                  "3500",
                  "2200",
                  "1200",
                  "600",
                ];
                const nextIdx = (modes.indexOf(abrMode) + 1) % modes.length;
                const nextMode = modes[nextIdx];
                setAbrMode(nextMode);
                if (nextMode !== "auto") {
                  applyBitrate(parseInt(nextMode, 10));
                }
              }}
              title="Toggle Adaptive Bitrate Ladder mode"
            >
              <span>
                {abrMode === "auto"
                  ? `ABR ${(targetBitrateKbps / 1000).toFixed(1)}M [AUTO]`
                  : `ABR ${(parseInt(abrMode, 10) / 1000).toFixed(1)}M [FIXED]`}
              </span>
            </JXButton>
            <span className="text-[var(--product-text-dim)]">|</span>
            <span>RTT {webrtcStats.rttMs}ms</span>
            <span className="text-[var(--product-text-dim)]">|</span>
            <span>Drop {webrtcStats.droppedFrames}</span>
          </div>
          <JXButton
            size="sm"
            color="neutral"
            variant="outlined"
            aria-pressed={isStreamActive}
            onClick={() => setIsStreamActive((prev) => !prev)}
          >
            <RefreshCw className={`w-3 h-3 ${isStreamActive ? "text-emerald-400" : "text-[var(--product-text-dim)]"}`} aria-hidden="true" />
            <span>Stream polling</span>
            <StatusBadge status={isStreamActive ? "active" : "paused"} />
          </JXButton>
          <JXButton
            size="sm"
            color={live && !isWindowsStreamHost ? "neutral" : "primary"}
            variant="outlined"
            onClick={() => {
              // UX-33: never a dead disabled button — when no stream is
              // possible this opens the explanatory panel instead.
              if (live && !isWindowsStreamHost) {
                setStreamHelpOpen((prev) => !prev);
                return;
              }
              void handleStartWebrtc();
            }}
            title={
              live && !isWindowsStreamHost
                ? "Why is there no stream? Open the explanation."
                : "Start or reconnect WebRTC desktop session"
            }
            aria-expanded={live && !isWindowsStreamHost ? streamHelpOpen : undefined}
          >
            <Radio className="w-3 h-3 text-indigo-400" aria-hidden="true" />
            <span>
              {live && !isWindowsStreamHost
                ? "Why no stream?"
                : webrtcSessionId
                  ? `WebRTC #${webrtcSessionId.slice(0, 6)}`
                  : "Start stream"}
            </span>
          </JXButton>
          {webrtcSessionId && (
            <JXButton
              size="sm"
              color="error"
              variant="outlined"
              onClick={() => cleanupWebrtc()}
              title="Terminate active WebRTC session"
            >
              <span>Stop stream</span>
            </JXButton>
          )}
        </div>
      </div>

      {/* UX-33: explanatory panel for "why no stream" — opened by the enabled
          "Why no stream?" button above. Which devices qualify is stated here. */}
      {live && !isWindowsStreamHost && streamHelpOpen && (
        <div className="space-y-2">
          <JXAlert
            severity="info"
            title="Why is there no stream?"
            description={
              streamUnavailableReason ||
              "No Windows device is selected. Live desktop streaming needs a Windows device that is online with desktop capture enabled. Linux and macOS agents do not expose a WebRTC desktop track."
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <JXButton size="sm" color="primary" variant="outlined" onClick={() => navigate("devices")}>
              Open fleet inventory
            </JXButton>
            <span className="text-xs text-[var(--product-text-tertiary)]">
              Qualifying devices: Windows, online, desktop capture enabled.
            </span>
          </div>
        </div>
      )}

      {/* UX-33: persistent offer-wait state with elapsed time and Cancel. */}
      {offerWait && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-xl bg-[var(--product-canvas)] border border-indigo-500/40"
        >
          <span className="text-xs font-mono text-indigo-300">
            Waiting for agent offer… {offerWaitElapsedSec}s elapsed (session {offerWait.sessionId})
          </span>
          <JXButton size="sm" color="neutral" variant="outlined" onClick={handleCancelOfferWait}>
            Cancel
          </JXButton>
        </div>
      )}

      {/* UX-33: session-status line, persisted until dismissed. */}
      {sessionStatus && !offerWait && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)]"
        >
          <span className="text-xs font-mono text-[var(--product-text-secondary)]">{sessionStatus}</span>
          <JXButton
            size="sm"
            color="neutral"
            variant="text"
            onClick={() => setSessionStatus(null)}
            aria-label="Dismiss session status"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </JXButton>
        </div>
      )}

      {/* Floating Dual-Control Takeover Bar — takeover/SoM/audio overlays are Windows devices only */}
      <div
        id="studio-controls"
        className={`p-3 rounded-2xl bg-[var(--product-surface)]/90 border border-[var(--product-line)] shadow-xl flex flex-wrap items-center justify-between gap-3 ${
          live && !isWindowsStreamHost ? "opacity-70" : ""
        }`}
      >
        <h2 className="sr-only">Studio controls</h2>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {/* Mode Segmented Switch */}
          {/* Both control rows are wider than a 390px phone, so they scroll inside
              themselves instead of pushing the whole view sideways. */}
          <div className="flex max-w-full overflow-x-auto p-1 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)]">
            <JXButton
              size="sm"
              color="primary"
              variant={controlMode === "observer" ? "contained" : "outlined"}
              aria-pressed={controlMode === "observer"}
              disabled={live && !isWindowsStreamHost}
              onClick={() => void applySessionMode("view_only")}
            >
              <Monitor className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Observer</span>
            </JXButton>
            <JXButton
              size="sm"
              color="primary"
              variant={controlMode === "takeover" && sessionMode === "human_control" ? "contained" : "outlined"}
              aria-pressed={controlMode === "takeover" && sessionMode === "human_control"}
              disabled={live && !isWindowsStreamHost}
              onClick={() => void applySessionMode("human_control")}
              title={live && !isWindowsStreamHost ? "Operator takeover requires a Windows device" : "Take control of the remote device"}
            >
              <span>Takeover</span>
            </JXButton>
            <JXButton
              size="sm"
              color="primary"
              variant={sessionMode === "ai_assisted" ? "contained" : "outlined"}
              aria-pressed={sessionMode === "ai_assisted"}
              disabled={live && !isWindowsStreamHost}
              onClick={() => void applySessionMode("ai_assisted")}
            >
              <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
              <span>AI-assisted</span>
            </JXButton>
          </div>

          <div className="h-6 w-px bg-[var(--product-raised)] hidden sm:block mx-1"></div>

          {/* Kinematic Input Toggles */}
          <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-x-auto">
            <JXButton
              size="sm"
              color={mouseLinked ? "primary" : "neutral"}
              variant="outlined"
              aria-pressed={mouseLinked}
              onClick={() => setMouseLinked(!mouseLinked)}
            >
              <Mouse className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Mouse Link</span>
              <span className={`w-1.5 h-1.5 rounded-full ${mouseLinked ? "bg-emerald-400" : "bg-[var(--product-text-dim)]"}`}></span>
            </JXButton>

            <JXButton
              size="sm"
              color={keyForwarded ? "primary" : "neutral"}
              variant="outlined"
              aria-pressed={keyForwarded}
              onClick={() => setKeyForwarded(!keyForwarded)}
            >
              <Keyboard className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Key Forward</span>
              <span className={`w-1.5 h-1.5 rounded-full ${keyForwarded ? "bg-emerald-400" : "bg-[var(--product-text-dim)]"}`}></span>
            </JXButton>

            <JXButton
              size="sm"
              color={clipboardSync ? "primary" : "neutral"}
              variant="outlined"
              aria-pressed={clipboardSync}
              aria-label={clipboardSync ? "Clipboard sync on" : "Clipboard sync off"}
              onClick={() => void handleSyncClipboard()}
            >
              <ClipboardCopy className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Clipboard Sync</span>
              {/* UX-28: the on/off state is text, not colour alone. */}
              <span>{clipboardSync ? "On" : "Off"}</span>
              <span className={`w-1.5 h-1.5 rounded-full ${clipboardSync ? "bg-indigo-400" : "bg-[var(--product-text-dim)]"}`}></span>
            </JXButton>

            <JXButton
              size="sm"
              color={pointerLockActive ? "primary" : "neutral"}
              variant="outlined"
              aria-pressed={pointerLockActive}
              onClick={togglePointerLock}
              title="Lock mouse cursor inside stream canvas for direct precision control (Press Esc to unlock)"
            >
              <Crosshair className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Pointer Lock</span>
              <span className={`w-1.5 h-1.5 rounded-full ${pointerLockActive ? "bg-indigo-400 animate-pulse" : "bg-[var(--product-text-dim)]"}`}></span>
            </JXButton>

            <JXButton
              size="sm"
              color={!isAudioMuted && desktopAudioCaptureLive ? "primary" : "neutral"}
              variant="outlined"
              aria-pressed={!isAudioMuted && desktopAudioCaptureLive}
              disabled={live && !isWindowsStreamHost}
              onClick={() => setIsAudioMuted(!isAudioMuted)}
              title={audioHonestyTitle}
            >
              {isAudioMuted ? <VolumeX className="w-3.5 h-3.5" aria-hidden="true" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />}
              <span>
                {desktopAudioCaptureLive
                  ? isAudioMuted
                    ? "Audio Muted"
                    : "Audio Active"
                  : desktopAudioOptIn
                    ? "Audio silent (opt-in)"
                    : "Audio off (opt-in)"}
              </span>
              <span className={`w-1.5 h-1.5 rounded-full ${!isAudioMuted && desktopAudioCaptureLive ? "bg-emerald-400 animate-pulse" : "bg-[var(--product-text-dim)]"}`}></span>
            </JXButton>

            <JXButton
              size="sm"
              color={fileDrawerOpen || activeTransfer ? "primary" : "neutral"}
              variant="outlined"
              aria-pressed={fileDrawerOpen}
              aria-expanded={fileDrawerOpen}
              onClick={() => {
                const next = !fileDrawerOpen;
                setFileDrawerOpen(next);
                if (next) void fetchRemoteFiles();
              }}
              title="Open device file transfer manager (Drag & drop files onto stream or select files)"
            >
              <Upload className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
              <span>Files</span>
              {activeTransfer && (
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" aria-hidden="true" />
              )}
            </JXButton>

            <JXButton
              size="sm"
              color="error"
              variant="outlined"
              onClick={handleSealSessionRecording}
              title="Seal encrypted session recording and commit Merkle proof to immutable audit trail"
            >
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
              <span>REC · Seal Audit</span>
            </JXButton>
          </div>
        </div>

        {/* Scaling, SoM Toggle, Snapshot */}
        <div className="flex items-center gap-2">
          {/* Scale Switcher */}
          <div className="flex p-1 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] font-mono text-xs">
            <JXButton
              size="sm"
              color="primary"
              variant={scalingMode === "fit" ? "contained" : "text"}
              aria-pressed={scalingMode === "fit"}
              onClick={() => setScalingMode("fit")}
            >
              Fit
            </JXButton>
            <JXButton
              size="sm"
              color="primary"
              variant={scalingMode === "native" ? "contained" : "text"}
              aria-pressed={scalingMode === "native"}
              onClick={() => setScalingMode("native")}
            >
              1:1 Native
            </JXButton>
            <JXButton
              size="sm"
              color="primary"
              variant={scalingMode === "fill" ? "contained" : "text"}
              aria-pressed={scalingMode === "fill"}
              onClick={() => setScalingMode("fill")}
            >
              Fill
            </JXButton>
          </div>

          {/* SoM Toggle — Windows OCR/SoM path only */}
          <JXButton
            size="sm"
            color={somOverlay && isWindowsStreamHost ? "primary" : "neutral"}
            variant="outlined"
            aria-pressed={somOverlay && isWindowsStreamHost}
            disabled={live && !isWindowsStreamHost}
            onClick={() => {
              if (live && !isWindowsStreamHost) {
                setRecentMacroNotice("Vision SoM is Windows-only (OCR/SoM not available on Linux/macOS agents).");
                setTimeout(() => setRecentMacroNotice(null), 3500);
                return;
              }
              toggleSomOverlay();
            }}
            title={
              live && !isWindowsStreamHost
                ? "Vision SoM requires a Windows device"
                : "Toggle Set-of-Marks overlay"
            }
          >
            <Crosshair className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
            <span>
              Vision SoM [{live && !isWindowsStreamHost ? "N/A" : somOverlay ? "ON" : "OFF"}]
            </span>
          </JXButton>

          {/* Screenshot Button — downloads a real PNG of the current frame (UX-08). */}
          <JXButton
            size="sm"
            color="neutral"
            variant="outlined"
            onClick={() => void handleCaptureSnapshot()}
            title="Capture desktop snapshot (downloads a PNG)"
            aria-label="Capture desktop snapshot (downloads a PNG)"
          >
            <Camera className="w-4 h-4" aria-hidden="true" />
          </JXButton>
        </div>
      </div>

      {/* Emergency Hotkey Macros Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 rounded-xl bg-[var(--product-canvas)]/80 border border-[var(--product-line)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--product-text-tertiary)] uppercase tracking-wider">
            Quick Hotkey Macros:
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              "Ctrl+Alt+Del",
              "Win / Super",
              "Alt+Tab",
              "Ctrl+Shift+Esc",
            ].map((macro) => (
              <button
                key={macro}
                type="button"
                onClick={() => dispatchMacro(macro)}
                className="px-2.5 py-1 min-h-11 sm:min-h-0 rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)] hover:border-[var(--product-line)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)] font-mono text-xs transition-all active:scale-95"
              >
                {macro}
              </button>
            ))}
            <button
              type="button"
              onClick={() => dispatchMacro("Unlock Screen")}
              className="px-2.5 py-1 min-h-11 sm:min-h-0 rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)] hover:border-[var(--product-line)] text-emerald-400 font-mono text-xs transition-all active:scale-95 flex items-center gap-1"
            >
              <Unlock className="w-3 h-3 text-emerald-400" />
              <span>Unlock Screen</span>
            </button>
            {/* UX-10: the file transfer is a data-submitting control, so it is
                a real <form> (Enter submits); UX-28: the hidden input has an
                accessible name. UX-39: the accept list is a picker hint for
                the common transfer types (documents, archives, images,
                video); the backend accepts any file type
                (POST /api/v1/devices/{id}/files/upload takes any filename —
                see src/ai_bridge/control/v1_routes.py), so this list is a
                UX choice, not a backend constraint, and "All files" in the
                picker still transfers anything. */}
            <form
              className="inline-flex"
              onSubmit={(e) => {
                e.preventDefault();
                fileInputRef.current?.click();
              }}
            >
              <button
                type="submit"
                className="px-2.5 py-1 min-h-11 sm:min-h-0 rounded-lg bg-cyan-950/70 border border-cyan-500/50 hover:border-cyan-400 text-cyan-300 font-mono text-xs transition-all active:scale-95 flex items-center gap-1"
                title="Upload file directly to remote device (/transfers)"
              >
                <Upload className="w-3 h-3 text-cyan-400" />
                <span>Transfer File</span>
              </button>
              <input
                type="file"
                ref={fileInputRef}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.zip,.tar,.gz,.tgz,.7z,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.mov"
                onChange={handleFileInputChange}
                className="hidden"
                aria-label="Choose file to transfer to remote device"
              />
            </form>
          </div>
        </div>

        {recentMacroNotice && (
          <div className="font-mono text-xs text-indigo-300 bg-indigo-950/60 px-3 py-1 rounded-lg border border-indigo-500/30">
            {recentMacroNotice}
          </div>
        )}

        <div className="flex items-center gap-2 font-mono text-xs text-[var(--product-text-tertiary)]">
          <span>Focus: Container [tty1]</span>
          <span className="px-2 py-0.5 rounded bg-[var(--product-raised)] text-indigo-300 font-bold">PID: 1042</span>
        </div>
      </div>

      {/* UX-11: visible keyboard-forwarding hint + explicit release control.
          The hint sits above the stage so it is seen before focus lands. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--product-text-tertiary)]">
          Keyboard input is sent to the remote device while the desktop area is focused.
          {controlMode === "takeover" ? " You are in control — press Esc to release." : " Observer mode — input is not forwarded."}
        </p>
        {controlMode === "takeover" && (
          <JXButton
            size="sm"
            color="primary"
            variant="outlined"
            onClick={() => void applySessionMode("view_only")}
          >
            Release control (Esc)
          </JXButton>
        )}
      </div>

      {/* Desktop Stream Viewport Canvas */}
      <div
        id="desktop-stream"
        ref={canvasContainerRef}
        tabIndex={0}
        role="application"
        aria-label="Remote desktop. Keyboard input is sent to the remote computer."
        onMouseMove={handleCanvasMouseMove}
        onMouseDown={handleCanvasMouseDown}
        onMouseUp={handleCanvasMouseUp}
        onClick={handleCanvasClick}
        onKeyDown={handleCanvasKeyDown}
        onKeyUp={handleCanvasKeyUp}
        onBlur={releaseAllRemoteKeys}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="relative w-full aspect-video min-h-[320px] sm:min-h-[560px] max-h-[760px] rounded-2xl bg-[var(--product-canvas)] border border-[var(--product-line)]/80 overflow-hidden shadow-2xl select-none group focus:outline-none focus:border-indigo-500/60"
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isAudioMuted}
          className={`absolute inset-0 w-full h-full z-20 transition-opacity duration-150 ${
            webrtcConnected ? "opacity-100" : "opacity-0 pointer-events-none"
          } ${
            scalingMode === "fill"
              ? "object-cover"
              : scalingMode === "native"
              ? "object-none"
              : "object-contain"
          }`}
        />

        {/* Encrypted Session Recording HUD Badge */}
        <div className="absolute top-3 left-3 z-30 pointer-events-none">
          <div className="px-2.5 py-1 rounded-xl bg-[var(--product-canvas)]/90 border border-[var(--product-line)] text-[11px] font-mono text-[var(--product-text-secondary)] shadow-xl flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
            <span className="font-semibold text-rose-400">REC</span>
            <span className="text-[var(--product-text-tertiary)]">Encrypted Manifest Linked</span>
          </div>
        </div>

        {/* Bi-Directional Drag-and-Drop Dropzone Overlay */}
        {isDraggingFile && (
          <div className="absolute inset-0 z-50 bg-cyan-950/85 backdrop-blur-sm border-4 border-dashed border-cyan-400 rounded-2xl flex flex-col items-center justify-center gap-3 pointer-events-none transition-all">
            <div className="p-4 rounded-2xl bg-cyan-500/20 border border-cyan-400/50 text-cyan-300 animate-bounce">
              <Upload className="w-10 h-10 text-cyan-400" />
            </div>
            <div className="text-center px-4 font-mono">
              <p className="font-semibold text-white text-base">Drop file to transfer directly to the remote device</p>
              <p className="text-xs text-cyan-300/80 mt-1">Streamed via WebRTC DataChannel (64 KB chunks, SHA-256 verified)</p>
            </div>
          </div>
        )}

        {liveFrameUrl && (
          <img
            src={liveFrameUrl}
            alt="Remote desktop stream frame"
            className={`absolute inset-0 w-full h-full z-10 transition-opacity duration-150 ${
              webrtcConnected ? "opacity-0 pointer-events-none" : "opacity-100"
            } ${
              scalingMode === "fill"
                ? "object-cover"
                : scalingMode === "native"
                ? "object-none"
                : "object-contain"
            }`}
          />
        )}

        {!liveFrameUrl && liveFrameMeta?.note && (
          <div className="absolute bottom-3 left-3 z-20 px-3 py-1.5 rounded-lg bg-[var(--product-canvas)]/90 border border-[var(--product-line)] text-xs font-mono text-[var(--product-text-secondary)]">
            {liveFrameMeta.note}
          </div>
        )}

        {/* Remote Operating System Canvas Simulation */}
        <div className="absolute inset-0 flex flex-col bg-[#0b0f19]">
          {/* OS Window Chrome Header */}
          <div className="h-8 bg-[var(--product-surface)]/90 border-b border-[var(--product-line)] px-3 flex items-center justify-between text-xs font-mono text-[var(--product-text-tertiary)]">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-rose-500/80"></span>
                <span className="w-3 h-3 rounded-full bg-amber-500/80"></span>
                <span className="w-3 h-3 rounded-full bg-emerald-500/80"></span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[var(--product-text-secondary)] font-semibold">ubuntu@srv-us-east-412:~</span>
                <span className="text-[11px] px-1.5 rounded bg-[var(--product-raised)] text-[var(--product-text-tertiary)]">X11/GNOME 46</span>
              </div>
            </div>

            <div className="flex items-center gap-4 text-[11px]">
              <span>CPU 24%</span>
              <span>RAM 12.4/64 GB</span>
              <span>GPU 41°C</span>
              <span className="text-[var(--product-text-secondary)] font-semibold">14:38:09 UTC</span>
            </div>
          </div>

          {/* Desktop Canvas Window Area */}
          <div className="flex-1 p-4 grid grid-cols-12 grid-rows-6 gap-3 overflow-hidden relative">
            {/* Window 1: VS Code Server (cols 1..8, rows 1..4) */}
            <div className="col-span-8 row-span-4 rounded-xl bg-[var(--product-canvas)]/95 border border-[var(--product-line)] shadow-2xl flex flex-col overflow-hidden relative">
              <div className="h-8 bg-[var(--product-surface)] px-3 flex items-center justify-between border-b border-[var(--product-line)] text-xs font-mono">
                <div className="flex items-center gap-2">
                  <Code className="w-3.5 h-3.5 text-indigo-400" />
                  <span className="text-[var(--product-text-secondary)] font-semibold">bridge_orchestrator.py — VS Code Server</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-emerald-400">
                  <span>● Python 3.12 (venv)</span>
                </div>
              </div>

              <div className="flex-1 p-3 font-mono text-xs leading-relaxed text-[var(--product-text-secondary)] flex gap-3 overflow-hidden">
                <div className="text-[var(--product-text-dim)] select-none text-right flex flex-col">
                  <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span><span>10</span>
                </div>
                <div className="flex-1 flex flex-col space-y-0.5 text-[var(--product-text-secondary)]">
                  <div><span className="text-rose-400">import</span> asyncio</div>
                  <div><span className="text-rose-400">from</span> ai_bridge.core <span className="text-rose-400">import</span> <span className="text-emerald-400">AutonomousAgentMesh</span></div>
                  <div className="text-[var(--product-text-dim)]"># Initialized from TaskQueue #TSK-89213</div>
                  <div><span className="text-rose-400">async def</span> <span className="text-cyan-400 font-semibold">execute_failover_handshake</span>(node_id: <span className="text-indigo-300">str</span>):</div>
                  <div className="pl-4"><span className="text-[var(--product-text-dim)]">&quot;&quot;&quot;Validates cryptographic peer quorum and routes TLS pipe.&quot;&quot;&quot;</span></div>
                  <div className="pl-4">session = <span className="text-rose-400">await</span> AutonomousAgentMesh.<span className="text-cyan-400">connect_peer</span>(node_id)</div>
                  <div className="pl-4"><span className="text-rose-400">if not</span> session.<span className="text-emerald-400">is_verified</span>():</div>
                  <div className="pl-8"><span className="text-rose-400">raise</span> <span className="text-rose-400">SecurityAssertionViolation</span>(<span className="text-amber-300">&quot;Quorum failed&quot;</span>)</div>
                  <div className="pl-4"><span className="text-rose-400">return await</span> session.<span className="text-cyan-400">dispatch_transaction</span>()</div>
                  <div className="mt-2 text-emerald-400 text-[11px]">● Live Sync: Auto-saved (2ms ago)</div>
                </div>
              </div>
            </div>

            {/* Window 2: Command Shell (cols 9..12, rows 1..6) */}
            <div className="col-span-4 row-span-6 rounded-xl bg-[var(--product-canvas)]/95 border border-[var(--product-line)] shadow-2xl flex flex-col overflow-hidden relative">
              <div className="h-8 bg-[var(--product-surface)] px-3 flex items-center justify-between border-b border-[var(--product-line)] text-xs font-mono">
                <div className="flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-[var(--product-text-secondary)] font-semibold">bash (PID 1042)</span>
                </div>
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              </div>

              <div className="flex-1 p-2.5 font-mono text-[11px] leading-relaxed text-[var(--product-text-secondary)] space-y-1 overflow-hidden">
                <div className="text-[var(--product-text-dim)]">sarah@srv-us-east-412:~$ docker ps</div>
                <div className="text-emerald-400 text-[11px]">CONTAINER ID   NAMES               STATUS</div>
                <div className="text-[var(--product-text-secondary)] text-[11px]">8f9a21e4cc     bridge-ingress-gw   Up 14h (healthy)</div>
                <div className="text-[var(--product-text-secondary)] text-[11px]">02c91fa09b     vector-indexer      Up 3h</div>
                <div className="text-[var(--product-text-secondary)] text-[11px]">e45a90d81c     webrtc-streamer     Up 14h</div>
                <div className="mt-2 text-[var(--product-text-dim)]">sarah@srv-us-east-412:~$ tail -f audit.log</div>
                <div className="text-[var(--product-text-tertiary)] text-[11px]">[14:37:58] Agent Sonnet requested keyboard event</div>
                <div className="text-cyan-400 text-[11px]">[14:38:01] Dual-Control arbiter: Granting operator priority</div>
                <div className="text-emerald-400 flex items-center gap-1 mt-2">
                  <span>sarah@srv-us-east-412:~$</span>
                  <span className="w-2 h-3.5 bg-emerald-400 inline-block animate-pulse"></span>
                </div>
              </div>
            </div>

            {/* Window 3: Performance Telemetry (cols 1..8, rows 5..6) */}
            <div className="col-span-8 row-span-2 rounded-xl bg-[var(--product-canvas)]/95 border border-[var(--product-line)] shadow-xl p-3 flex flex-col justify-between relative overflow-hidden">
              <div className="flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2 text-[var(--product-text-secondary)] font-semibold">
                  <Activity className="w-3.5 h-3.5 text-indigo-400" />
                  <span>System Performance Realtime Telemetry</span>
                </div>
                <StatusBadge
                  status={webrtcConnected ? "running" : "idle"}
                  label={webrtcConnected ? `Session active · ${webrtcStats.fps} fps` : "No active encode session"}
                />
              </div>

              <div className="grid grid-cols-4 gap-2 pt-1 font-mono">
                <div className="p-2 rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)]">
                  <span className="text-[11px] text-[var(--product-text-dim)] uppercase block">CPU UTIL</span>
                  <span className="text-sm font-bold text-[var(--product-text-secondary)]">24.2%</span>
                </div>
                <div className="p-2 rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)]">
                  <span className="text-[11px] text-[var(--product-text-dim)] uppercase block">GPU VRAM</span>
                  <span className="text-sm font-bold text-emerald-400">4.8 GB</span>
                </div>
                <div className="p-2 rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)]">
                  <span className="text-[11px] text-[var(--product-text-dim)] uppercase block">NETWORK I/O</span>
                  <span className="text-sm font-bold text-indigo-300">14.8 Mb/s</span>
                </div>
                <div className="p-2 rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)]">
                  <span className="text-[11px] text-[var(--product-text-dim)] uppercase block">AGENT-TO-GROUND</span>
                  <span className="text-sm font-bold text-cyan-400">PASSIVE</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Set-of-Marks (SoM) Bounding Visual Segmentation Map */}
        {somOverlay && (
          <div className="absolute inset-0 pointer-events-none z-30">
            {somElements.length > 0 ? (
              somElements.slice(0, 8).map((elem, idx) => {
                const posClass = SOM_POSITION_PRESETS[idx % SOM_POSITION_PRESETS.length];
                return (
                  <div
                    key={elem.id}
                    onClick={() => {
                      if (controlMode === "takeover" && mouseLinked && selectedDevice?.id) {
                        sendDataChannelEvent({
                          type: "mouse_button",
                          action: "click",
                          button: "left",
                          x: elem.center_x,
                          y: elem.center_y,
                          normalized: true,
                        });
                        setRecentMacroNotice(`Dispatched click to SoM #${elem.id} [${elem.label}]`);
                        setTimeout(() => setRecentMacroNotice(null), 2500);
                      }
                    }}
                    className={`absolute ${posClass} border-2 border-indigo-400/80 bg-indigo-500/10 rounded-xl flex items-start justify-between p-1.5 transition-all pointer-events-auto cursor-pointer hover:bg-indigo-500/25 hover:border-indigo-300 shadow-lg`}
                    title={`Click to target SoM #${elem.id}: ${elem.label} (${elem.type})`}
                  >
                    <span className="px-1.5 py-0.5 rounded bg-indigo-600 text-white font-mono text-[11px] font-bold shadow-md">
                      #{elem.id}
                    </span>
                    <span className="font-mono text-[11px] text-indigo-200 bg-[var(--product-canvas)]/90 px-1.5 py-0.5 rounded border border-indigo-500/30 truncate max-w-[130px]">
                      {elem.label}
                    </span>
                  </div>
                );
              })
            ) : (
              <>
                {/* Fallback default initial grounding targets */}
                <div className="absolute left-[4%] top-[10%] w-[60%] h-[56%] border-2 border-indigo-400/70 bg-indigo-500/5 rounded-xl flex items-start justify-between p-2">
                  <span className="px-2 py-0.5 rounded bg-indigo-600 text-white font-mono text-[11px] font-bold shadow-md">
                    SoM #1 • Editor Workspace
                  </span>
                  <span className="font-mono text-[11px] text-indigo-300 bg-[var(--product-canvas)]/80 px-1.5 py-0.5 rounded border border-indigo-500/30">
                    Target: active_buffer
                  </span>
                </div>
                <div className="absolute left-[66%] top-[10%] w-[30%] h-[80%] border-2 border-emerald-400/70 bg-emerald-500/5 rounded-xl flex items-start justify-between p-2">
                  <span className="px-2 py-0.5 rounded bg-emerald-800 text-white font-mono text-[11px] font-bold shadow-md">
                    SoM #2 • Command Shell
                  </span>
                  <span className="font-mono text-[11px] text-emerald-300 bg-[var(--product-canvas)]/80 px-1.5 py-0.5 rounded border border-emerald-500/30">
                    Target: bash_pty
                  </span>
                </div>
                <div className="absolute left-[4%] top-[70%] w-[60%] h-[24%] border-2 border-cyan-400/70 bg-cyan-500/5 rounded-xl flex items-start justify-between p-2">
                  <span className="px-2 py-0.5 rounded bg-cyan-800 text-white font-mono text-[11px] font-bold shadow-md">
                    SoM #3 • Telemetry Metrics
                  </span>
                  <span className="font-mono text-[11px] text-cyan-300 bg-[var(--product-canvas)]/80 px-1.5 py-0.5 rounded border border-cyan-500/30">
                    Target: gpu_vitals
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Dual Cursor HUD Overlay */}
        {/* Cursor 1: AI Agent Target Crosshair */}
        <div className="absolute left-[36%] top-[34%] pointer-events-none z-30 flex items-start gap-1">
          <div className="w-5 h-5 rounded-full border-2 border-indigo-400 bg-indigo-500/20 flex items-center justify-center animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
          </div>
          <div className="px-2 py-0.5 rounded bg-indigo-600 text-white font-mono text-[11px] font-semibold shadow-lg">
            Agent: Claude-3.5-Sonnet (X: 1420, Y: 840)
          </div>
        </div>

        {/* Cursor 2: Human Operator Pointer */}
        <div className="absolute left-[54%] top-[24%] pointer-events-none z-30 flex items-start gap-1">
          <div className="w-4 h-4 rounded-full border-2 border-emerald-400 bg-emerald-500/30 flex items-center justify-center">
            <span className="w-1 h-1 rounded-full bg-emerald-300"></span>
          </div>
          <div className="px-2 py-0.5 rounded bg-[var(--product-surface)]/90 backdrop-blur-md border border-emerald-500/40 text-emerald-300 font-mono text-[11px] font-semibold shadow-lg">
            Operator: Sarah J. (X: {operatorCoords.x}, Y: {operatorCoords.y})
          </div>
        </div>

        {/* AI Action Anticipation (Ghost Trajectory & Grace Period) */}
        {pendingIntent && (
          <div className="absolute inset-0 pointer-events-none z-40">
            {/* Trajectory Guide Line linking Agent to Target */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none stroke-cyan-400 stroke-2 opacity-80">
              <line x1="36%" y1="34%" x2="58%" y2="38%" strokeDasharray="4 4" />
            </svg>

            {/* Target Ring at Destination */}
            <div className="absolute left-[58%] top-[38%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-2">
              <div className="relative flex items-center justify-center">
                <span className="w-12 h-12 rounded-full border-2 border-cyan-400 bg-cyan-500/20 animate-ping absolute"></span>
                <span className="w-8 h-8 rounded-full border-2 border-cyan-300 bg-cyan-400/40 flex items-center justify-center shadow-lg shadow-cyan-500/50">
                  <Crosshair className="w-4 h-4 text-white" />
                </span>
              </div>

              {/* Action Intent Banner with Countdown & Veto Action */}
              <div className="pointer-events-auto p-2.5 rounded-xl bg-[var(--product-canvas)]/95 border border-cyan-500/60 shadow-2xl flex flex-col items-center gap-1.5 min-w-[220px]">
                <div className="flex items-center gap-1.5 text-xs font-mono font-bold text-cyan-300">
                  <Zap className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Anticipated AI Action</span>
                </div>
                <div className="text-[11px] font-mono text-[var(--product-text-secondary)] font-semibold truncate max-w-[200px]">
                  {pendingIntent.target_label}
                </div>
                {/* Countdown progress indicator — UX-24: a real progress
                    bar (remaining fraction of the grace period, via the
                    shared JXLinearProgress), not a pulsing placeholder;
                    pulse is reserved for live/online indicators. */}
                <JXLinearProgress
                  value={pendingIntent.countdown_ms > 0 ? (countdownRemainingMs / pendingIntent.countdown_ms) * 100 : 0}
                  label={`AI action executes in ${(countdownRemainingMs / 1000).toFixed(1)} seconds`}
                  className="h-1.5"
                />
                <div className="flex items-center justify-between w-full pt-1 gap-2">
                  <span className="font-mono text-[11px] text-[var(--product-text-tertiary)]">
                    Executing in {(countdownRemainingMs / 1000).toFixed(1)}s
                  </span>
                  <button
                    type="button"
                    onClick={handleVetoAction}
                    className="px-2.5 py-0.5 min-h-11 sm:min-h-0 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-mono text-[11px] font-bold shadow-md transition-all active:scale-95 flex items-center gap-1"
                  >
                    <span>Veto [Esc]</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* UX-33/UX-39: the duplicate "Operator Takeover Active" banner was
            removed — the takeover bar above is the single indicator. */}

        {/* Pointer Lock Status Badge */}
        {pointerLockActive && (
          <div className="absolute top-3 right-3 pointer-events-none z-30">
            <div className="px-3 py-1.5 rounded-xl bg-[var(--product-canvas)]/95 border border-indigo-500/60 text-xs font-mono text-indigo-300 shadow-xl flex items-center gap-2">
              <Crosshair className="w-3.5 h-3.5 text-indigo-400" />
              <span>Pointer Locked · Press [ESC] to unlock</span>
            </div>
          </div>
        )}

        {/* WebRTC Auto-Healing Reconnect Banner */}
        {isReconnecting && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 pointer-events-none z-30">
            <div className="px-4 py-1.5 rounded-full bg-amber-950/90 border border-amber-500/60 text-xs font-mono text-amber-300 shadow-xl flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-400" />
              <span>WebRTC Reconnecting (Auto-healing stream)...</span>
            </div>
          </div>
        )}

      </div>

      {/* Bi-Directional File Transfer Manager & Drawer */}
      {fileDrawerOpen && (
        <div id="file-transfer" className="p-4 rounded-2xl bg-[var(--product-canvas)]/95 border border-cyan-500/40 backdrop-blur-md shadow-2xl flex flex-col gap-3 font-mono text-xs">
          <h2 className="sr-only">File transfer</h2>
          <div className="flex items-center justify-between border-b border-[var(--product-line)] pb-2">
            <div className="flex items-center gap-2 text-cyan-400 font-semibold">
              <Folder className="w-4 h-4 text-cyan-400" />
              <span>Device file transfer & storage (`/transfers`)</span>
            </div>
            <div className="flex items-center gap-2">
              <JXButton
                size="sm"
                color="primary"
                variant="outlined"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                <span>Upload File</span>
              </JXButton>
              <button
                type="button"
                onClick={() => void fetchRemoteFiles()}
                className="px-2 py-1 min-h-11 sm:min-h-0 rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)] text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)] transition-colors"
                title="Refresh remote files"
                aria-label="Refresh remote files"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setFileDrawerOpen(false)}
                className="px-2 py-1 min-h-11 sm:min-h-0 rounded-lg bg-[var(--product-surface)] border border-[var(--product-line)] text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)] transition-colors"
                title="Close file manager"
                aria-label="Close file manager"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Active In-Progress Transfer Progress HUD */}
          {activeTransfer && (
            <div className="p-3 rounded-xl bg-[var(--product-surface)]/90 border border-cyan-500/30 flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-cyan-400" />
                  <span className="text-[var(--product-text-secondary)] font-semibold">{activeTransfer.filename}</span>
                  <span className="text-[var(--product-text-dim)] text-[11px]">
                    ({(activeTransfer.size / 1024).toFixed(1)} KB)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400 font-bold">{activeTransfer.percent}%</span>
                  <StatusBadge
                    status={
                      activeTransfer.status === "completed"
                        ? "completed"
                        : activeTransfer.status === "error"
                          ? "failed"
                          : "running"
                    }
                    label={
                      activeTransfer.status === "completed"
                        ? "Completed"
                        : activeTransfer.status === "verifying"
                          ? "Verifying SHA-256…"
                          : activeTransfer.status === "error"
                            ? "Failed"
                            : `${activeTransfer.speed_kbps} KB/s`
                    }
                  />
                </div>
              </div>

              {/* Progress bar using compliant preset classes */}
              <div className="w-full bg-[var(--product-raised)] rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full bg-cyan-400 rounded-full transition-all duration-200 ${
                    activeTransfer.percent >= 100
                      ? "w-full"
                      : activeTransfer.percent >= 75
                      ? "w-3/4"
                      : activeTransfer.percent >= 50
                      ? "w-1/2"
                      : activeTransfer.percent >= 25
                      ? "w-1/4"
                      : "w-2"
                  }`}
                />
              </div>

              {activeTransfer.error && (
                <div className="text-[11px] text-rose-400 bg-rose-950/40 px-2 py-1 rounded border border-rose-500/30">
                  {activeTransfer.error}
                </div>
              )}
            </div>
          )}

          {/* Transferred files on the remote device */}
          <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
            {recentTransfers.length === 0 ? (
              <div className="p-4 text-center text-[var(--product-text-dim)] text-xs">
                No transferred files found on the remote device. Drag and drop any file onto the stream or click Upload File.
              </div>
            ) : (
              recentTransfers.map((f) => (
                <div
                  key={f.full_path}
                  className="flex items-center justify-between p-2 rounded-xl bg-[var(--product-surface)]/60 border border-[var(--product-line)]/80 hover:border-[var(--product-line)] transition-colors"
                >
                  <div className="flex items-center gap-2.5 truncate max-w-[70%]">
                    <FileText className="w-3.5 h-3.5 text-[var(--product-text-tertiary)] shrink-0" />
                    <span className="text-[var(--product-text-secondary)] truncate">{f.name}</span>
                    <span className="text-[var(--product-text-dim)] text-[11px] shrink-0">
                      {(f.size_bytes / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => requestFileDownload(f)}
                      className="px-2 py-1 min-h-11 sm:min-h-0 rounded-lg bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-cyan-300 text-[11px] flex items-center gap-1 transition-colors"
                      title="Download file to browser"
                    >
                      <Download className="w-3 h-3 text-cyan-400" />
                      <span>Download</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(f.full_path).catch(() => {});
                        setRecentMacroNotice(`Copied device path to clipboard: ${f.full_path}`);
                        setTimeout(() => setRecentMacroNotice(null), 2500);
                      }}
                      className="px-2 py-1 min-h-11 sm:min-h-0 rounded-lg bg-[var(--product-raised)] hover:bg-[var(--product-raised)] text-[var(--product-text-secondary)] text-[11px] transition-colors"
                      title="Copy absolute remote path"
                    >
                      Copy Path
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Active Windows HUD Tray (Collapsible & Focusable) */}
      <div id="windows" className="p-3 rounded-2xl bg-[var(--product-surface)]/90 border border-[var(--product-line)] shadow-xl flex flex-col md:flex-row items-center justify-between gap-4">
        <h2 className="sr-only">Windows</h2>
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <span className="font-mono text-xs uppercase tracking-wider text-[var(--product-text-tertiary)] pl-1 hidden sm:inline">
            Windows
          </span>
          {windowsList.map((win) => {
            const isFocused = win.id === activeWindowId;
            return (
              <div
                key={win.id}
                onClick={() => focusWindow(win.id)}
                className={`flex items-center gap-2 px-3 py-1.5 min-h-11 sm:min-h-0 rounded-xl border text-xs font-mono cursor-pointer transition-all ${
                  isFocused
                    ? "bg-indigo-950/60 border-indigo-500 text-[var(--product-text)] shadow-md shadow-indigo-600/10"
                    : "bg-[var(--product-canvas)]/70 border-[var(--product-line)] text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)] hover:border-[var(--product-line)]"
                }`}
              >
                {win.icon === "terminal" && <Terminal className="w-3.5 h-3.5 text-emerald-400" />}
                {win.icon === "code" && <Code className="w-3.5 h-3.5 text-indigo-400" />}
                {win.icon === "docker" && <Layers className="w-3.5 h-3.5 text-cyan-400" />}
                {win.icon === "monitor" && <Activity className="w-3.5 h-3.5 text-amber-400" />}
                <div className="flex flex-col text-left">
                  <span className="font-semibold text-[var(--product-text-secondary)]">{win.name}</span>
                  <span className="text-[11px] text-[var(--product-text-dim)]">{win.desc}</span>
                </div>
                {isFocused && <span className="w-2 h-2 rounded-full bg-emerald-400 ml-1"></span>}
              </div>
            );
          })}
        </div>

        {/* Window Manager Actions */}
        <div className="flex items-center gap-2 w-full md:w-auto justify-end">
          <JXButton
            size="sm"
            color="neutral"
            variant="outlined"
            onClick={() => focusWindow(activeWindowId)}
          >
            <Crosshair className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
            <span>Focus Active</span>
          </JXButton>
          <JXButton
            size="sm"
            color="neutral"
            variant="outlined"
            onClick={() => dispatchMacro(`Minimize ${activeWindow.name}`)}
          >
            <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Minimize</span>
          </JXButton>
          <JXButton
            size="sm"
            color="error"
            variant="outlined"
            onClick={() => dispatchMacro(`Graceful Stop PID ${activeWindow.pid}`)}
          >
            <Power className="w-3.5 h-3.5 text-rose-400" aria-hidden="true" />
            <span>Graceful Stop</span>
          </JXButton>
        </div>
      </div>
        </>
      )}

    </div>
  );
};

export default LiveDesktopView;
