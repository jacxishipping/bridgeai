/**
 * AI API & Custom Agents Hub (Screen 9)
 * Reconstructed with pure JXUI primitives, motion/react, and lucide-react.
 * ZERO inline styles. ZERO custom CSS.
 */

import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ConfirmDestructive,
  JXCard,
  JXCardHeader,
  JXCardContent,
  JXButton,
  JXBadge,
  JXSelect,
  JXTextField,
  JXTabs,
  StatusBadge,
  EmptyState,
} from "../ui";
import {
  Bot,
  Cpu,
  Zap,
  Shield,
  Activity,
  Copy,
  Check,
  Play,
  Terminal,
  Code2,
  Radio,
  Sparkles,
  RefreshCw,
  Server,
  Layers,
  KeyRound,
  CheckCircle2,
  Pause,
  Trash2,
  Clock3,
  ChevronDown,
  ChevronUp,
  Network,
  Plus,
  Wrench,
  Globe,
  Link2,
  Pencil,
  X,
  Send,
  MessageSquare,
  Eye,
  EyeOff,
} from "lucide-react";
import { useDashboardStore } from "../state/dashboardStore";
import { api, sessionToken, token } from "../api";
import { pushNotice } from "../state/notices";
import { Freshness } from "../components/Freshness";
import { useLanguage, formatDate } from "../i18n";

interface ProviderConnector {
  id: string;
  name: string;
  defaultModel: string;
  /**
   * Live state only, from GET /api/settings/ai. "configured" when the
   * backend reports a key for this provider, "not_configured" otherwise.
   * "healthy"/"degraded" are set only by a real Test ping. No status,
   * latency or key here is ever hardcoded (D-03).
   */
  status: "healthy" | "degraded" | "offline" | "configured" | "not_configured";
  /** Measured round-trip ms from a real Test ping, or null when never measured. */
  latencyMs: number | null;
  /** Masked key exactly as reported by the backend, or null when none is configured. */
  keyMasked: string | null;
  endpoint: string;
  isPinging?: boolean;
}

interface AiSettingsResponse {
  provider: string;
  model: string;
  keys_configured: Record<string, boolean>;
  masked_keys: Record<string, string>;
  custom_base_url: string;
  custom_model: string;
  is_connected: boolean;
}

// Backend accepts these through /api/settings/ai; "custom" is any
// OpenAI-compatible endpoint (OpenRouter, LiteLLM, vLLM, LM Studio...).
const AI_PROVIDER_OPTIONS = [
  { id: "custom", label: "Custom AI (OpenAI-compatible)" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic Claude" },
  { id: "gemini", label: "Google Gemini" },
  { id: "groq", label: "Groq" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "ollama", label: "Ollama / local" },
];

interface McpServerTool {
  name: string;
  description: string;
  inputSchema?: any;
}

interface McpServerItem {
  id: string;
  name: string;
  url: string;
  transport: string;
  auth_type?: string;
  enabled: boolean;
  status: "healthy" | "offline" | "pending_auth" | "unknown";
  last_checked_at?: number | null;
  last_error?: string;
  tools_count: number;
  tools: McpServerTool[];
  token_masked?: string;
  oauth_connected?: boolean;
  oauth_has_refresh_token?: boolean;
}

interface McpTemplate {
  id: string;
  name: string;
  url: string;
  description: string;
  requires_auth: boolean;
  auth_type?: string;
  oauth_auth_url?: string;
  oauth_token_url?: string;
  oauth_scopes?: string;
  category?: string;
  auth_placeholder?: string;
}

const DEVICE_TOOL_OPTIONS = [
  { id: "take_screenshot", label: "Desktop Screenshot", category: "gui" },
  { id: "set_of_marks_screenshot", label: "Set-of-Marks Screenshot", category: "gui" },
  { id: "click_element", label: "GUI Click Element", category: "gui" },
  { id: "mouse_click", label: "Mouse Click", category: "gui" },
  { id: "keyboard_type", label: "Keyboard Type Text", category: "gui" },
  { id: "launch_approved_application", label: "Launch Application", category: "gui" },
  { id: "run_shell", label: "Run Shell / Terminal", category: "system" },
  { id: "list_processes", label: "Process Inventory", category: "system" },
  { id: "get_system_info", label: "System Info", category: "system" },
  { id: "get_network_info", label: "Network Telemetry", category: "system" },
  { id: "file_read", label: "Read Workspace File", category: "files" },
  { id: "file_write", label: "Write Workspace File", category: "files" },
  { id: "file_list", label: "List Directory Files", category: "files" },
  { id: "git_status", label: "Git Repository Status", category: "git" },
];

interface CustomAgent {
  id: string;
  name: string;
  instruction: string;
  provider: string;
  model?: string | null;
  base_url?: string | null;
  device_ids: string[];
  devices: Array<{ id: string; name?: string; hostname?: string; os?: string; status?: string }>;
  interval_seconds: number;
  enabled: boolean;
  status: string;
  last_run_at?: number | null;
  last_result?: string;
  last_error?: string;
  run_count: number;
  consecutive_failures?: number;
  memory?: string;
  allowed_tools?: string[];
  mcp_server_ids?: string[];
  mcp_servers?: McpServerItem[];
}

/**
 * UX-18: map common failure statuses to plain-language explanations with a
 * next step, instead of echoing the raw server string. `uncertain` (the
 * api.ts flag for "the request may have reached the server") is surfaced
 * explicitly — for a remote-control product, not knowing whether a command
 * ran is itself a safety issue. Callers that mutate add a pushNotice with
 * a "Check status" deep link (see the save/create/delete handlers).
 */
function describeError(error: unknown): string {
  const status = (error as { status?: number })?.status;
  const uncertain = (error as { uncertain?: boolean })?.uncertain;
  const raw = error instanceof Error ? error.message : String(error);
  if (status === 401) return "Your session expired. Sign in again to continue.";
  if (status === 403) return "Access denied (403). Your account may lack permission for this action — ask an admin to check your role, then try again.";
  if (status === 409) return "Conflict (409). The server refused this change because the current state conflicts with it — reload the latest data and try again.";
  if (status === 429) return "Too many requests (429). Wait a minute and try again.";
  if (status && status >= 500) return `Control plane error (${status}). The server failed to complete this — try again, and check the audit trail to see whether it went through.`;
  if (uncertain) return `${raw} Outcome unknown — the server may have received this request. Check the audit trail before submitting again.`;
  return raw;
}

function relativeTime(timestamp: number | null | undefined, locale: string): string {
  if (!timestamp) return "never";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return rtf.format(-seconds, "second");
  if (seconds < 3600) return rtf.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return rtf.format(-Math.floor(seconds / 3600), "hour");
  return rtf.format(-Math.floor(seconds / 86400), "day");
}

function formatInterval(seconds: number): string {
  if (seconds >= 86400) return "once a day";
  if (seconds >= 3600) return `every ${Math.round(seconds / 3600)}h`;
  return `every ${Math.max(1, Math.round(seconds / 60))} min`;
}

const AGENT_INTERVAL_OPTIONS = [
  { id: "60", label: "Every minute" },
  { id: "300", label: "Every 5 minutes" },
  { id: "900", label: "Every 15 minutes" },
  { id: "3600", label: "Every hour" },
  { id: "21600", label: "Every 6 hours" },
  { id: "86400", label: "Once a day" },
];

const SDK_SNIPPETS = {
  python: `# Python SDK Integration
from ai_bridge import BridgeClient

client = BridgeClient(
    api_key="brg_live_sk99214a08bc71",
    gateway_url="https://bridge.internal/v1",
    tls_verify=True
)

# Dispatch desktop observation tool
response = client.tools.execute(
    target_node="srv-us-east-412",
    tool="desktop_get_screenshot",
    arguments={"include_som": True, "format": "png"}
)

print(f"Captured screen hash: {response.result['image_hash']}")
print(f"Detected {len(response.result['som_marks'])} UI elements")`,

  typescript: `// TypeScript / Node.js REST Integration (Node 18+ built-in fetch)
const endpoint = 'https://bridge.internal/api/ai/execute';

async function main() {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${process.env.AI_BRIDGE_API_KEY ?? ''}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      device_id: 'srv-us-east-412',
      tool: 'get_system_info',
      arguments: {},
    }),
  });

  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
  console.log('System telemetry:', await response.json());
}

main().catch(console.error);`,

  curl: `# cURL / REST HTTP Endpoint
curl -X POST "https://bridge.internal/v1/tools/dispatch" \\
  -H "Authorization: Bearer brg_live_sk99214a08bc71" \\
  -H "Content-Type: application/json" \\
  -d '{
    "device_id": "srv-us-east-412",
    "tool": "desktop_get_screenshot",
    "arguments": {
      "format": "png",
      "include_som": true
    }
  }'`,

  mcp: `// MCP (Model Context Protocol) JSON-RPC 2.0 Payload
{
  "jsonrpc": "2.0",
  "id": 10842,
  "method": "tools/call",
  "params": {
    "name": "desktop_get_screenshot",
    "arguments": {
      "target_node": "srv-us-east-412",
      "include_som": true,
      "format": "png"
    }
  }
}`,
};

export const AiApiHubView: React.FC = () => {
  const devices = useDashboardStore((s) => s.devices);
  // UX-39: sub-tab state (Providers / Agents / MCP / Chat).
  const [activeTab, setActiveTab] = useState<"providers" | "agents" | "mcp" | "chat">("providers");
  // UX-06: sync freshness in the header when live; UX-29: timestamps and
  // numbers go through useLanguage() with an explicit timeZone.
  const syncState = useDashboardStore((s) => s.syncState);
  const lastSyncAt = useDashboardStore((s) => s.lastSyncAt);
  const { locale, date, number } = useLanguage();

  // Provider connector state. D-03: the cards below show live state only
  // (from GET /api/settings/ai) or "Not configured". Previous hardcoded
  // masked keys, fixed latencies and stale model lists have been deleted;
  // there is no demo data in this list anymore.
  const PROVIDER_DESCRIPTORS = [
    {
      id: "anthropic",
      name: "Anthropic Claude",
      defaultModel: "claude-3-5-sonnet-20241022",
      endpoint: "https://api.anthropic.com/v1/messages",
    },
    {
      id: "openai",
      name: "OpenAI",
      defaultModel: "gpt-4o",
      endpoint: "https://api.openai.com/v1/chat/completions",
    },
    {
      id: "gemini",
      name: "Google Gemini",
      defaultModel: "gemini-1.5-pro",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
    },
    {
      id: "ollama",
      name: "Local Ollama / vLLM",
      defaultModel: "llama3.1:8b-instruct",
      endpoint: (import.meta as any).env?.VITE_OLLAMA_URL || "http://localhost:11434/v1",
    },
  ];
  const [providers, setProviders] = useState<ProviderConnector[]>(() =>
    PROVIDER_DESCRIPTORS.map((d) => ({
      ...d,
      status: "not_configured" as const,
      latencyMs: null,
      // Ollama is local and needs no key; every other provider starts
      // with no key until the backend reports one.
      keyMasked: d.id === "ollama" ? "No key required — local endpoint" : null,
    }))
  );

  // SDK Code Generator state
  const [sdkLang, setSdkLang] = useState<"python" | "typescript" | "curl" | "mcp">("python");
  const [copiedCode, setCopiedCode] = useState(false);

  // Interactive Execution Studio state
  const [selectedNode, setSelectedNode] = useState(devices[0]?.id || "srv-us-east-412");
  const [selectedModel, setSelectedModel] = useState("claude-3-5-sonnet-20241022");
  const [selectedTool, setSelectedTool] = useState("desktop_get_screenshot");
  const [promptText, setPromptText] = useState(
    JSON.stringify(
      {
        format: "png",
        include_som: true,
        compression_level: 4,
      },
      null,
      2
    )
  );

  const [isExecuting, setIsExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<{
    status: string;
    nodeId: string;
    tool: string;
    model: string;
    durationMs: number;
    tokens: { input: number; output: number; cost: string };
    output: Record<string, unknown>;
  } | null>(null);

  // Live provider settings: the provider cards above are driven by this
  // panel's GET /api/settings/ai response (keys_configured / masked_keys),
  // so a real key or self-hosted endpoint is what the cards show.
  const isLive = typeof window !== "undefined" && Boolean(token() || sessionToken());
  const [aiSettings, setAiSettings] = useState<AiSettingsResponse | null>(null);
  const [aiProvider, setAiProvider] = useState("custom");
  const [aiModel, setAiModel] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  // UX-21: show/hide for the secret fields (AI key, MCP bearer token,
  // MCP client secret) so a pasted credential can be verified.
  const [showAiKey, setShowAiKey] = useState(false);
  // UX-20: blur validation for the long provider form.
  const [aiBaseUrlTouched, setAiBaseUrlTouched] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiClearing, setAiClearing] = useState(false);

  // Custom 24/7 agents
  const [agents, setAgents] = useState<CustomAgent[]>([]);
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentInstruction, setAgentInstruction] = useState("");
  const [agentProvider, setAgentProvider] = useState("openai");
  const [agentModel, setAgentModel] = useState("");
  const [agentBaseUrl, setAgentBaseUrl] = useState("");
  const [agentInterval, setAgentInterval] = useState("300");
  const [agentDeviceIds, setAgentDeviceIds] = useState<string[]>([]);
  const [agentMcpServerIds, setAgentMcpServerIds] = useState<string[]>([]);
  const [agentAllowedTools, setAgentAllowedTools] = useState<string[]>([]);
  const [agentMemory, setAgentMemory] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  // UX-03: pending agent deletion; only runs from ConfirmDestructive.
  const [deleteAgentConfirm, setDeleteAgentConfirm] = useState<CustomAgent | null>(null);
  const [agentRunsOpen, setAgentRunsOpen] = useState<Record<string, boolean>>({});
  const [expandedRunTrace, setExpandedRunTrace] = useState<Record<string, boolean>>({});
  const [askTargetAgent, setAskTargetAgent] = useState<CustomAgent | null>(null);
  const [askPrompt, setAskPrompt] = useState("");
  const [askResult, setAskResult] = useState<{ response: string; steps: any[] } | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [memoryTargetAgent, setMemoryTargetAgent] = useState<CustomAgent | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryChunks, setMemoryChunks] = useState<{ content: string; project_tag?: string; task_tag?: string; chunk_index?: number }[]>([]);
  const [memoryProjectFilter, setMemoryProjectFilter] = useState("");
  const [memoryTaskFilter, setMemoryTaskFilter] = useState("");
  const [memoryChunkDraft, setMemoryChunkDraft] = useState("");
  const [agentRuns, setAgentRuns] = useState<Record<string, any[]>>({});
  const [agentRunsLoading, setAgentRunsLoading] = useState<Record<string, boolean>>({});

  // Interactive AI Copilot Chat state (persisted in localStorage)
  interface CopilotMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    steps?: any[];
    provider?: string;
    model?: string;
    createdAt: string;
  }
  const [copilotMessages, setCopilotMessages] = useState<CopilotMessage[]>(() => {
    try {
      const raw = window.localStorage.getItem("ai_bridge_copilot_messages");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore localStorage read errors
    }
    return [];
  });
  const [copilotInput, setCopilotInput] = useState("");
  const [copilotDevice, setCopilotDevice] = useState("");
  const [copilotProvider, setCopilotProvider] = useState("");
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [copilotExpandedSteps, setCopilotExpandedSteps] = useState<Record<string, boolean>>({});
  const [copilotLiveEvents, setCopilotLiveEvents] = useState<Array<{ step?: number; tool?: string; device?: string; status: string }>>([]);
  const [mcpToolPolicies, setMcpToolPolicies] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "ai_bridge_copilot_messages",
        JSON.stringify(copilotMessages.slice(-40))
      );
    } catch {
      // ignore localStorage quota errors
    }
  }, [copilotMessages]);

  const handleCopilotSend = async (e?: React.FormEvent): Promise<void> => {
    if (e) e.preventDefault();
    const prompt = copilotInput.trim();
    if (!prompt || copilotBusy) return;
    const userMsg: CopilotMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    const nextHistory = [...copilotMessages, userMsg];
    setCopilotMessages(nextHistory);
    setCopilotInput("");
    setCopilotLiveEvents([]);
    setCopilotBusy(true);
    try {
      const payloadMessages = nextHistory.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
      const st = sessionToken();
      const at = token();
      if (st) headers["X-Session-Token"] = st;
      else if (at) headers["X-Admin-Token"] = at;

      let res: {
        ok?: boolean;
        message?: { role?: string; content?: string };
        steps?: any[];
        provider?: string;
        model?: string;
      } | null = null;

      try {
        const streamRes = await fetch(api.aiChatStreamUrl(), {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: payloadMessages,
            provider: copilotProvider || undefined,
            device: copilotDevice || undefined,
          }),
        });
        if (!streamRes.ok || !streamRes.body) {
          throw new Error(`HTTP ${streamRes.status}`);
        }
        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const ev = JSON.parse(dataLine.slice(5).trim());
              if (ev.type === "tool_start") {
                setCopilotLiveEvents((prev) => [...prev, { step: ev.step, tool: ev.tool, device: ev.device, status: "running" }]);
              } else if (ev.type === "tool_result") {
                setCopilotLiveEvents((prev) =>
                  prev.map((item, i) =>
                    i === prev.length - 1 && item.tool === ev.tool
                      ? { ...item, status: ev.ok ? "done" : "error" }
                      : item
                  )
                );
              } else if (ev.type === "error") {
                throw new Error(ev.error || "Streaming error");
              } else if (ev.type === "done") {
                res = ev;
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message !== "Unexpected end of JSON input") {
                throw parseErr;
              }
            }
          }
        }
      } catch {
        res = (await api.aiChat({
          messages: payloadMessages,
          provider: copilotProvider || undefined,
          device: copilotDevice || undefined,
        })) as any;
      }

      const replyContent =
        res?.message?.content?.trim() || "(No response returned)";
      const assistantMsg: CopilotMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: replyContent,
        steps: Array.isArray(res?.steps) ? res.steps : [],
        provider: res?.provider,
        model: res?.model,
        createdAt: new Date().toISOString(),
      };
      setCopilotMessages((prev) => [...prev, assistantMsg]);
    } catch (error) {
      pushNotice({ tone: "error", title: "Copilot request failed", message: describeError(error) });
    } finally {
      setCopilotBusy(false);
      setCopilotLiveEvents([]);
    }
  };

  const handleSaveCopilotAsWorkflow = async (msg: CopilotMessage): Promise<void> => {
    const steps = (msg.steps || [])
      .filter((s: any) => s && s.tool)
      .map((s: any, idx: number) => ({
        name: `Copilot Step ${idx + 1}: ${s.tool}`,
        action: s.tool,
        args: s.args && typeof s.args === "object" ? s.args : {},
      }));
    if (steps.length === 0) return;
    try {
      const tpl = await api.createWorkflowTemplate({
        name: `Copilot Flow (${formatDate(new Date(), { hour: "2-digit", minute: "2-digit", second: "2-digit" })})`,
        description: msg.content.slice(0, 140),
        steps,
      });
      pushNotice({ tone: "success", title: "Workflow template saved", message: `Saved workflow template "${tpl.name}" (${steps.length} step${steps.length === 1 ? "" : "s"}).` });
    } catch (error) {
      pushNotice({ tone: "error", title: "Copilot request failed", message: describeError(error) });
    }
  };

  const handleMcpPolicyChange = async (srvId: string, toolName: string, policy: string): Promise<void> => {
    const key = `${srvId}:${toolName}`;
    const next = { ...mcpToolPolicies };
    if (policy === "allow") delete next[key];
    else next[key] = policy;
    setMcpToolPolicies(next);
    try {
      const res = await api.updateMcpToolPolicies(next);
      if (res?.policies) setMcpToolPolicies(res.policies);
    } catch (error) {
      pushNotice({ tone: "error", title: "MCP Service Notice", message: describeError(error) });
    }
  };

  const handleCopilotClear = (): void => {
    setCopilotMessages([]);
    try {
      window.localStorage.removeItem("ai_bridge_copilot_messages");
    } catch {
      // ignore
    }
  };

  // MCP Services state
  const [mcpServers, setMcpServers] = useState<McpServerItem[]>([]);
  const [mcpTemplates, setMcpTemplates] = useState<McpTemplate[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpAuthType, setMcpAuthType] = useState("bearer");
  const [mcpAuthToken, setMcpAuthToken] = useState("");
  const [showMcpToken, setShowMcpToken] = useState(false);
  const [mcpAuthHeader, setMcpAuthHeader] = useState("");
  const [mcpOAuthClientId, setMcpOAuthClientId] = useState("");
  const [mcpOAuthClientSecret, setMcpOAuthClientSecret] = useState("");
  const [showMcpSecret, setShowMcpSecret] = useState(false);
  // UX-20: blur validation for the long MCP form.
  const [mcpNameTouched, setMcpNameTouched] = useState(false);
  const [mcpUrlTouched, setMcpUrlTouched] = useState(false);
  const [mcpOAuthAuthUrl, setMcpOAuthAuthUrl] = useState("");
  const [mcpOAuthTokenUrl, setMcpOAuthTokenUrl] = useState("");
  const [mcpOAuthScopes, setMcpOAuthScopes] = useState("");
  const [mcpDiscovering, setMcpDiscovering] = useState(false);
  const [mcpSyncing, setMcpSyncing] = useState<Record<string, boolean>>({});
  // UX-06: MCP servers refresh on a 10 s interval, so a failed poll must not
  // stack a new persistent error notice every 10 s (the old inline notice
  // was a single slot). Push only when the message changes; clear on success.
  const lastMcpLoadErrorRef = useRef<string | null>(null);
  // UX-03: pending MCP-service disconnect; only runs from ConfirmDestructive.
  const [deleteMcpConfirm, setDeleteMcpConfirm] = useState<McpServerItem | null>(null);
  const [mcpToolsExpanded, setMcpToolsExpanded] = useState<Record<string, boolean>>({});
  const [aiCatalogTools, setAiCatalogTools] = useState<string[]>([]);
  const [aiFleetDevices, setAiFleetDevices] = useState<{ id: string; hostname?: string; name?: string; status?: string }[]>([]);

  const loadAiSettings = async (): Promise<void> => {
    if (!isLive) return;
    try {
      const [settings, toolsRes, fleetRes] = await Promise.all([
        api.getAiSettings() as Promise<AiSettingsResponse>,
        api.aiTools("raw").catch(() => null),
        api.aiFleet().catch(() => null),
      ]);
      if (Array.isArray(toolsRes?.tools)) {
        setAiCatalogTools(
          toolsRes.tools
            .map((t: any) => String(t?.name || t?.function?.name || ""))
            .filter(Boolean)
        );
      }
      if (Array.isArray(fleetRes?.devices)) {
        setAiFleetDevices(fleetRes.devices);
      } else if (Array.isArray(fleetRes)) {
        setAiFleetDevices(fleetRes);
      }
      setAiSettings(settings);
      // Drive the provider cards from the live settings: a provider shows
      // "Configured" with the backend's masked key only when the backend
      // reports a key for it; otherwise it shows "Not configured".
      setProviders((prev) =>
        prev.map((p) => {
          if (p.id === "ollama") return p;
          const configured = Boolean(settings.keys_configured?.[p.id]);
          return {
            ...p,
            status: configured ? "configured" : "not_configured",
            keyMasked: configured ? settings.masked_keys?.[p.id] ?? null : null,
          };
        })
      );
      if (settings.provider) setAiProvider(settings.provider);
      if (settings.provider === "custom") {
        setAiModel(settings.custom_model || settings.model || "");
        setAiBaseUrl(settings.custom_base_url || "");
      } else {
        setAiModel(settings.model || "");
      }
    } catch (error) {
      pushNotice({ tone: "error", title: "Could not save provider", message: describeError(error) });
    }
  };

  useEffect(() => {
    void loadAiSettings();
    // Reload only when the sign-in state changes; the endpoint is admin-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  const handleSaveAi = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault();
    if (aiProvider === "custom" && !aiBaseUrl.trim()) {
      pushNotice({ tone: "error", title: "Could not save provider", message: "A base URL is required for a custom AI provider, e.g. https://openrouter.ai/api/v1" });
      return;
    }
    setAiSaving(true);
    try {
      const result = await api.saveAiSettings({
        provider: aiProvider,
        model: aiModel.trim() || undefined,
        api_key: aiApiKey.trim() || undefined,
        base_url: aiProvider === "custom" ? aiBaseUrl.trim() : undefined,
        test_connection: true,
      });
      pushNotice({ tone: "success", title: result?.message || "AI provider connected." });
      setAiApiKey("");
      await loadAiSettings();
    } catch (error) {
      const text = describeError(error);
      pushNotice({ tone: "error", title: "Could not save provider", message: text, actionLabel: "Check audit trail", actionHref: "#/audit-trail" });
    } finally {
      setAiSaving(false);
    }
  };

  const handleClearAi = async (): Promise<void> => {
    setAiClearing(true);
    try {
      const result = await api.saveAiSettings({ provider: aiProvider, clear: true });
      pushNotice({ tone: "success", title: "Provider saved", message: result?.message || "Provider settings cleared." });
      setAiApiKey("");
      await loadAiSettings();
    } catch (error) {
      pushNotice({ tone: "error", title: "Could not save provider", message: describeError(error) });
    } finally {
      setAiClearing(false);
    }
  };

  const loadAgents = async (silent = false): Promise<void> => {
    if (!isLive) return;
    try {
      const result = await api.agents();
      setAgents(result.agents || []);
    } catch (error) {
      if (!silent) pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
    }
  };

  const loadMcpServers = async (): Promise<void> => {
    if (!isLive) return;
    setMcpLoading(true);
    try {
      const [res, polRes] = await Promise.all([
        api.mcpServers(),
        api.mcpToolPolicies().catch(() => ({ policies: {} })),
      ]);
      setMcpServers(res.servers || []);
      lastMcpLoadErrorRef.current = null;
      if (polRes?.policies) setMcpToolPolicies(polRes.policies);
    } catch (error) {
      const text = describeError(error);
      if (lastMcpLoadErrorRef.current !== text) {
        lastMcpLoadErrorRef.current = text;
        pushNotice({ tone: "error", title: "MCP Service Notice", message: text });
      }
    } finally {
      setMcpLoading(false);
    }
  };

  const loadMcpTemplates = async (): Promise<void> => {
    if (!isLive) return;
    try {
      const res = await api.mcpTemplates();
      setMcpTemplates(res.templates || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!isLive) return;
    void loadAgents(true);
    void loadMcpServers();
    void loadMcpTemplates();
    const timer = window.setInterval(() => {
      void loadAgents(true);
      void loadMcpServers();
    }, 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  const openAgentForm = (): void => {
    setEditingAgentId(null);
    setAgentName("");
    setAgentInstruction("");
    setAgentDeviceIds(devices.filter((d) => d.status === "online").map((d) => d.id));
    setAgentInterval("300");
    const provider = aiSettings?.provider || "openai";
    setAgentProvider(provider);
    setAgentModel(provider === "custom" ? aiSettings?.custom_model || "" : aiSettings?.model || "");
    setAgentBaseUrl(aiSettings?.custom_base_url || "");
    setAgentMcpServerIds(mcpServers.filter((s) => s.enabled).map((s) => s.id));
    setAgentAllowedTools([]);
    setAgentMemory("");
    setAgentFormOpen(true);
  };

  const handleEditAgent = (agent: CustomAgent): void => {
    setEditingAgentId(agent.id);
    setAgentName(agent.name);
    setAgentInstruction(agent.instruction);
    setAgentProvider(agent.provider || "openai");
    setAgentModel(agent.model || "");
    setAgentBaseUrl(agent.base_url || "");
    setAgentInterval(String(agent.interval_seconds || 300));
    setAgentDeviceIds(agent.device_ids || []);
    setAgentMcpServerIds(agent.mcp_server_ids || []);
    setAgentAllowedTools(agent.allowed_tools || []);
    setAgentMemory(agent.memory || "");
    setAgentFormOpen(true);
  };

  const handleCloseAgentForm = (): void => {
    setAgentFormOpen(false);
    setEditingAgentId(null);
    setAgentName("");
    setAgentInstruction("");
    setAgentDeviceIds([]);
    setAgentMcpServerIds([]);
    setAgentAllowedTools([]);
    setAgentMemory("");
  };

  const handleDiscoverMcpOAuth = async (): Promise<void> => {
    if (!mcpUrl.trim()) {
      pushNotice({ tone: "error", title: "MCP Service Notice", message: "Enter the MCP Endpoint URL first to auto-discover OAuth2 endpoints." });
      return;
    }
    setMcpDiscovering(true);
    try {
      const meta = await api.discoverMcpOAuth(mcpUrl.trim());
      if (meta.ok) {
        if (meta.authorization_endpoint) setMcpOAuthAuthUrl(meta.authorization_endpoint);
        if (meta.token_endpoint) setMcpOAuthTokenUrl(meta.token_endpoint);
        pushNotice({ tone: "success", title: "MCP Service", message: `Discovered OAuth2 endpoints from ${meta.issuer || mcpUrl}.` });
      } else {
        pushNotice({ tone: "info", title: "MCP Service Notice", message: meta.error || "No .well-known OAuth metadata found; enter endpoints manually." });
      }
    } catch (error) {
      pushNotice({ tone: "error", title: "MCP Service Notice", message: describeError(error) });
    } finally {
      setMcpDiscovering(false);
    }
  };

  const handleStartMcpOAuth = async (serverId: string): Promise<void> => {
    setMcpLoading(true);
    try {
      const res = await api.startMcpOAuth(serverId);
      if (!res.authorize_url) {
        throw new Error("OAuth2 authorization URL was not returned.");
      }
      const onMsg = (evt: MessageEvent) => {
        if (evt.data && evt.data.type === "mcp_oauth_complete" && evt.data.server_id === serverId) {
          window.removeEventListener("message", onMsg);
          pushNotice({
            tone: evt.data.ok ? "success" : "error",
            title: evt.data.ok ? "MCP Service" : "MCP Service Notice",
            message: evt.data.message || (evt.data.ok ? "OAuth2 authorized." : "OAuth2 failed."),
          });
          void loadMcpServers();
        }
      };
      window.addEventListener("message", onMsg);
      const popup = window.open(res.authorize_url, "ai_bridge_mcp_oauth", "width=620,height=740");
      if (!popup) {
        window.removeEventListener("message", onMsg);
        window.location.href = res.authorize_url;
      } else {
        pushNotice({ tone: "info", title: "MCP Service Notice", message: "Complete OAuth2 authorization in the popup window." });
      }
    } catch (error) {
      pushNotice({ tone: "error", title: "MCP Service Notice", message: describeError(error) });
    } finally {
      setMcpLoading(false);
    }
  };

  const handleCreateMcpServer = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!mcpName.trim() || !mcpUrl.trim()) {
      pushNotice({ tone: "error", title: "MCP Service Notice", message: "MCP service name and URL are required." });
      return;
    }
    setMcpLoading(true);
    try {
      const res = await api.createMcpServer({
        name: mcpName.trim(),
        url: mcpUrl.trim(),
        auth_type: mcpAuthType,
        auth_token: mcpAuthType === "bearer" ? mcpAuthToken.trim() || undefined : undefined,
        auth_header: mcpAuthType === "bearer" ? mcpAuthHeader.trim() || undefined : undefined,
        oauth_client_id: mcpAuthType.startsWith("oauth2_") ? mcpOAuthClientId.trim() || undefined : undefined,
        oauth_client_secret: mcpAuthType.startsWith("oauth2_") ? mcpOAuthClientSecret.trim() || undefined : undefined,
        oauth_auth_url: mcpAuthType === "oauth2_pkce" ? mcpOAuthAuthUrl.trim() || undefined : undefined,
        oauth_token_url: mcpAuthType.startsWith("oauth2_") ? mcpOAuthTokenUrl.trim() || undefined : undefined,
        oauth_scopes: mcpAuthType.startsWith("oauth2_") ? mcpOAuthScopes.trim() || undefined : undefined,
        enabled: true,
      });
      const createdId = res.server?.id;
      pushNotice({ tone: "success", title: res.message || `Connected to ${mcpName}. Discovered ${res.tools_count} tools.` });
      setMcpName("");
      setMcpUrl("");
      setMcpAuthType("bearer");
      setMcpAuthToken("");
      setMcpAuthHeader("");
      setMcpOAuthClientId("");
      setMcpOAuthClientSecret("");
      setMcpOAuthAuthUrl("");
      setMcpOAuthTokenUrl("");
      setMcpOAuthScopes("");
      setMcpFormOpen(false);
      await loadMcpServers();
      if (mcpAuthType === "oauth2_pkce" && createdId && !res.server?.oauth_connected) {
        await handleStartMcpOAuth(createdId);
      }
    } catch (error) {
      const text = describeError(error);
      pushNotice({ tone: "error", title: "Could not connect MCP service", message: text, actionLabel: "Check audit trail", actionHref: "#/audit-trail" });
    } finally {
      setMcpLoading(false);
    }
  };

  const handleSyncMcpServer = async (serverId: string): Promise<void> => {
    setMcpSyncing((prev) => ({ ...prev, [serverId]: true }));
    try {
      const res = await api.syncMcpServer(serverId);
      pushNotice({ tone: res.ok ? "success" : "error", title: res.ok ? "MCP Service" : "MCP Service Notice", message: res.message || "MCP server synchronized." });
      await loadMcpServers();
    } catch (error) {
      pushNotice({ tone: "error", title: "MCP Service Notice", message: describeError(error) });
    } finally {
      setMcpSyncing((prev) => ({ ...prev, [serverId]: false }));
    }
  };

  const handleToggleMcpServer = async (srv: McpServerItem): Promise<void> => {
    setMcpLoading(true);
    try {
      await api.updateMcpServer(srv.id, { enabled: !srv.enabled });
      pushNotice({ tone: "success", title: "MCP Service", message: `MCP service "${srv.name}" ${srv.enabled ? "disabled" : "enabled"}.` });
      await loadMcpServers();
    } catch (error) {
      pushNotice({ tone: "error", title: "MCP Service Notice", message: describeError(error) });
    } finally {
      setMcpLoading(false);
    }
  };

  const handleTestMcpTool = async (srvId: string, toolName: string): Promise<void> => {
    setMcpLoading(true);
    try {
      const res = await api.executeMcpTool(srvId, toolName, {});
      pushNotice({
        tone: "info",
        title: "MCP Service Notice",
        message: `MCP tool ${toolName} returned: ${JSON.stringify(res?.result ?? res).slice(0, 180)}`,
      });
    } catch (error) {
      pushNotice({ tone: "error", title: "MCP Service Notice", message: describeError(error) });
    } finally {
      setMcpLoading(false);
    }
  };

  const handleDeleteMcpServer = async (server: McpServerItem): Promise<void> => {
    setMcpLoading(true);
    try {
      await api.deleteMcpServer(server.id);
      pushNotice({ tone: "success", title: "MCP Service", message: `MCP service "${server.name}" removed.` });
      await loadMcpServers();
    } catch (error) {
      pushNotice({ tone: "error", title: "MCP Service Notice", message: describeError(error) });
    } finally {
      setMcpLoading(false);
    }
  };

  const handleSaveAgent = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!agentName.trim() || !agentInstruction.trim() || agentDeviceIds.length === 0) {
      pushNotice({ tone: "error", title: "Could not update agent", message: "Give the agent a name, an objective, and at least one device." });
      return;
    }
    if (agentProvider === "custom" && !agentBaseUrl.trim()) {
      pushNotice({ tone: "error", title: "Could not update agent", message: "A base URL is required for the custom AI provider." });
      return;
    }
    setAgentBusy(true);
    try {
      if (editingAgentId) {
        await api.updateAgent(editingAgentId, {
          name: agentName.trim(),
          instruction: agentInstruction.trim(),
          provider: agentProvider,
          model: agentModel.trim() || undefined,
          base_url: agentProvider === "custom" ? agentBaseUrl.trim() || undefined : undefined,
          device_ids: agentDeviceIds,
          interval_seconds: Math.max(30, parseInt(agentInterval, 10) || 300),
          allowed_tools: agentAllowedTools,
          mcp_server_ids: agentMcpServerIds,
          memory: agentMemory,
        });
        pushNotice({ tone: "success", title: `${agentName.trim()} updated successfully.` });
      } else {
        await api.createAgent({
          name: agentName.trim(),
          instruction: agentInstruction.trim(),
          provider: agentProvider,
          model: agentModel.trim() || undefined,
          base_url: agentProvider === "custom" ? agentBaseUrl.trim() || undefined : undefined,
          device_ids: agentDeviceIds,
          interval_seconds: Math.max(30, parseInt(agentInterval, 10) || 300),
          enabled: true,
          allowed_tools: agentAllowedTools.length > 0 ? agentAllowedTools : undefined,
          mcp_server_ids: agentMcpServerIds,
        });
        pushNotice({ tone: "success", title: `${agentName.trim()} is live and will run on its interval.` });
      }
      handleCloseAgentForm();
      await loadAgents(true);
    } catch (error) {
      const text = describeError(error);
      pushNotice({ tone: "error", title: "Could not save agent", message: text, actionLabel: "Check audit trail", actionHref: "#/audit-trail" });
    } finally {
      setAgentBusy(false);
    }
  };

  const handleToggleAgent = async (agent: CustomAgent): Promise<void> => {
    setAgentBusy(true);
    try {
      await api.updateAgent(agent.id, { enabled: !agent.enabled });
      pushNotice({ tone: "success", title: "Custom agents", message: agent.enabled ? `${agent.name} paused.` : `${agent.name} resumed.` });
      await loadAgents(true);
    } catch (error) {
      pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
    } finally {
      setAgentBusy(false);
    }
  };

  const handleRunAgent = async (agent: CustomAgent): Promise<void> => {
    setAgentBusy(true);
    try {
      await api.runAgentNow(agent.id);
      pushNotice({ tone: "info", title: "Agent run", message: `Run queued for ${agent.name}. Results appear after the next cycle.` });
      window.setTimeout(() => void loadAgents(true), 2500);
    } catch (error) {
      pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
    } finally {
      setAgentBusy(false);
    }
  };

  const handleDeleteAgent = async (agent: CustomAgent): Promise<void> => {
    setAgentBusy(true);
    try {
      await api.deleteAgent(agent.id);
      pushNotice({ tone: "success", title: "Custom agents", message: `${agent.name} deleted.` });
      await loadAgents(true);
    } catch (error) {
      pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
    } finally {
      setAgentBusy(false);
    }
  };

  const handleToggleAgentRuns = async (agent: CustomAgent): Promise<void> => {
    const open = !agentRunsOpen[agent.id];
    setAgentRunsOpen((prev) => ({ ...prev, [agent.id]: open }));
    if (open && !agentRuns[agent.id]) {
      setAgentRunsLoading((prev) => ({ ...prev, [agent.id]: true }));
      try {
        const result = await api.agentRuns(agent.id);
        setAgentRuns((prev) => ({ ...prev, [agent.id]: result.runs || [] }));
      } catch (error) {
        pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
      } finally {
        setAgentRunsLoading((prev) => ({ ...prev, [agent.id]: false }));
      }
    }
  };

  const loadMemoryChunks = async (agentId: string, project?: string, task?: string): Promise<void> => {
    try {
      const res = await api.agentMemoryChunks(agentId, {
        project: project || undefined,
        task: task || undefined,
        limit: 50,
      });
      setMemoryChunks(Array.isArray(res?.chunks) ? res.chunks : []);
    } catch {
      setMemoryChunks([]);
    }
  };

  const openMemoryEditor = (agent: CustomAgent): void => {
    setMemoryTargetAgent(agent);
    setMemoryDraft(agent.memory || "");
    setMemoryProjectFilter("");
    setMemoryTaskFilter("");
    setMemoryChunkDraft("");
    void loadMemoryChunks(agent.id);
  };

  const handleClearAgentMemory = async (agent: CustomAgent): Promise<void> => {
    setAgentBusy(true);
    try {
      await api.clearAgentMemoryChunks(agent.id).catch(() => null);
      await api.updateAgent(agent.id, { memory: "" });
      pushNotice({ tone: "success", title: "Custom agents", message: `Memory cleared for ${agent.name}.` });
      await loadAgents(true);
    } catch (error) {
      pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
    } finally {
      setAgentBusy(false);
    }
  };

  const handleSaveAgentMemory = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!memoryTargetAgent) return;
    setAgentBusy(true);
    try {
      await api.updateAgent(memoryTargetAgent.id, { memory: memoryDraft });
      pushNotice({ tone: "success", title: "Custom agents", message: `Updated memory for ${memoryTargetAgent.name}.` });
      setMemoryTargetAgent(null);
      await loadAgents(true);
    } catch (error) {
      pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
    } finally {
      setAgentBusy(false);
    }
  };

  const handleAskAgentSubmit = async (event?: React.FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!askTargetAgent || !askPrompt.trim()) return;
    setAskBusy(true);
    setAskResult(null);
    try {
      const res = await api.askAgent(askTargetAgent.id, askPrompt.trim());
      setAskResult({ response: res?.response || "", steps: Array.isArray(res?.steps) ? res.steps : [] });
      await loadAgents(true);
    } catch (error) {
      pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
    } finally {
      setAskBusy(false);
    }
  };

  const handlePing = async (providerId: string) => {
    // No live control plane, no ping: a previous version fabricated a
    // latency from the provider id here. The Test button is disabled
    // when signed out, so this guard is a second line of defence.
    if (!isLive) return;
    setProviders((prev) =>
      prev.map((p) => (p.id === providerId ? { ...p, isPinging: true } : p))
    );
    const t0 = performance.now();
    try {
      await Promise.all([api.getAiSettings(), api.aiTools("raw", selectedNode || undefined)]);
      const measuredMs = Math.max(1, Math.round(performance.now() - t0));
      setProviders((prev) =>
        prev.map((p) =>
          p.id === providerId ? { ...p, isPinging: false, latencyMs: measuredMs, status: "healthy" } : p
        )
      );
    } catch {
      const measuredMs = Math.max(1, Math.round(performance.now() - t0));
      setProviders((prev) =>
        prev.map((p) =>
          p.id === providerId ? { ...p, isPinging: false, latencyMs: measuredMs, status: "degraded" } : p
        )
      );
    }
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(SDK_SNIPPETS[sdkLang]);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleExecuteTool = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setIsExecuting(true);
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = promptText.trim() ? JSON.parse(promptText) : {};
    } catch {
      parsedArgs = { prompt: promptText };
    }
    const t0 = performance.now();
    if (isLive) {
      try {
        const liveResult =
          selectedTool === "ai_agent"
            ? await api.aiAgent({
                prompt: String(parsedArgs.prompt || promptText),
                device: selectedNode || undefined,
                model: selectedModel || undefined,
              })
            : await api.aiExecute({
                tool: selectedTool,
                device: selectedNode || undefined,
                args: parsedArgs,
              });
        const elapsed = Math.max(1, Math.round(performance.now() - t0));
        setExecutionResult({
          status: String(liveResult?.status || (liveResult?.ok === false ? "failed" : "fulfilled")),
          nodeId: selectedNode || "control-plane",
          tool: selectedTool,
          model: selectedModel,
          durationMs: elapsed,
          tokens: {
            input: Number(liveResult?.usage?.input_tokens || 0),
            output: Number(liveResult?.usage?.output_tokens || 0),
            cost: "live",
          },
          output: (liveResult && typeof liveResult === "object" ? liveResult : { result: liveResult }) as Record<string, unknown>,
        });
      } catch (error) {
        const elapsed = Math.max(1, Math.round(performance.now() - t0));
        setExecutionResult({
          status: "error",
          nodeId: selectedNode || "control-plane",
          tool: selectedTool,
          model: selectedModel,
          durationMs: elapsed,
          tokens: { input: 0, output: 0, cost: "error" },
          output: { error: describeError(error) },
        });
      } finally {
        setIsExecuting(false);
      }
      return;
    }

    setIsExecuting(false);
    // Demo mode cannot execute anything: there is no control plane and no
    // device. Report that instead of fabricating a fulfilled result with
    // invented tokens and a fake sandbox verifier.
    setExecutionResult({
      status: "not_executed",
      nodeId: selectedNode,
      tool: selectedTool,
      model: selectedModel,
      durationMs: 0,
      tokens: {
        input: 0,
        output: 0,
        cost: "not executed",
      },
      output: {
        error:
          "Demo mode: no live control plane is connected, so this tool was not run anywhere. Sign in to execute it against a real device.",
      },
    });
  };

  return (
    <div className="space-y-4">
      {/* UX-36: explicit top-level heading (this view previously had none). */}
      {/* UX-39: sub-tabs (Providers / Agents / MCP / Chat) + in-page section nav. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-[var(--product-text)]">AI providers &amp; agents</h1>
          <p className="text-xs text-[var(--product-text-tertiary)]">Connect an AI provider, wire up MCP services, run 24/7 agents, and chat with the Copilot — each area is a tab below.</p>
        </div>
        {isLive && <Freshness checkedAt={lastSyncAt} loading={syncState === "loading"} label="Updated" /> }
      </header>
      <JXTabs
        value={activeTab}
        onChange={(value) => setActiveTab(value as "providers" | "agents" | "mcp" | "chat")}
        tabs={[
          { id: "providers", label: "Providers", icon: <KeyRound className="w-3.5 h-3.5" /> },
          { id: "agents", label: "Agents", icon: <Bot className="w-3.5 h-3.5" /> },
          { id: "mcp", label: "MCP", icon: <Network className="w-3.5 h-3.5" /> },
          { id: "chat", label: "Chat", icon: <MessageSquare className="w-3.5 h-3.5" /> },
        ]}
      />
      {activeTab === "providers" && (<div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base font-semibold text-[var(--product-text)]">Providers</h2>
          </div>
        </div>

        <JXCard>
          <JXCardHeader
            title="Connect your AI"
            subheader="Connect a provider key or any OpenAI-compatible endpoint. The key is stored on the server and only ever shown masked here."
            icon={<KeyRound className="w-4 h-4" />}
          />
          <JXCardContent>
            <form onSubmit={(event) => void handleSaveAi(event)}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <JXSelect
                label="Provider"
                options={AI_PROVIDER_OPTIONS}
                value={aiProvider}
                onChange={(value) => {
                  setAiProvider(value);
                  if (value === "custom") {
                    setAiBaseUrl(aiSettings?.custom_base_url || "");
                    setAiModel(aiSettings?.custom_model || "");
                  }
                }}
              />
              <JXTextField
                label="Model"
                value={aiModel}
                onChange={setAiModel}
                placeholder="gpt-4o-mini, claude-3-5-sonnet, llama3.1:8b"
              />
              {aiProvider === "custom" && (
                <div className="md:col-span-2">
                  <JXTextField
                    label="Base URL"
                    value={aiBaseUrl}
                    onChange={setAiBaseUrl}
                    onBlur={() => setAiBaseUrlTouched(true)}
                    aria-invalid={aiBaseUrlTouched && !aiBaseUrl.trim()}
                    aria-describedby={aiBaseUrlTouched && !aiBaseUrl.trim() ? "ai-base-url-error" : undefined}
                    autoComplete="url"
                    placeholder="https://openrouter.ai/api/v1"
                  />
                  {aiBaseUrlTouched && !aiBaseUrl.trim() && (
                    <p id="ai-base-url-error" role="alert" className="mt-1 text-[11px] text-amber-300">A base URL is required for a custom AI provider.</p>
                  )}
                </div>
              )}
              <div className="md:col-span-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <JXTextField
                      label="API key"
                      type={showAiKey ? "text" : "password"}
                      value={aiApiKey}
                      onChange={setAiApiKey}
                      clearable={false}
                      autoComplete="off"
                      placeholder={
                        aiSettings?.masked_keys?.[aiProvider]
                        || (aiProvider === "ollama" ? "Not required for local Ollama" : "Paste the provider API key")
                      }
                    />
                  </div>
                  <JXButton type="button" variant="outlined" color="neutral" size="sm" className="mt-6 min-h-11 shrink-0"
                    aria-pressed={showAiKey} aria-label={showAiKey ? "Hide API key" : "Show API key"}
                    title={showAiKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowAiKey((prev) => !prev)}>
                    {showAiKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </JXButton>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--product-text-tertiary)]">The key is stored on the control plane and used to call this provider for the Copilot and your agents. It is never shown in full here — only the masked form the server reports.</p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--product-text-tertiary)]">
              <JXBadge
                color={aiSettings?.is_connected ? "success" : "neutral"}
                statusText={aiSettings?.is_connected ? "Connected" : "Not connected"}
              />
              <span>
                {aiSettings
                  ? `Active: ${aiSettings.provider}${aiSettings.model ? ` \u00b7 ${aiSettings.model}` : ""}`
                  : "Provider settings unavailable"}
              </span>
              {aiSettings?.masked_keys?.[aiSettings.provider] && (
                <code className="font-mono">{aiSettings.masked_keys[aiSettings.provider]}</code>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <JXButton
                type="submit"
                variant="contained"
                color="primary"
                size="md"
                loading={aiSaving}
                disabled={!isLive || aiSaving}
                startIcon={<CheckCircle2 className="w-4 h-4" />}
              >
                Save &amp; test
              </JXButton>
              <JXButton
                type="button"
                variant="outlined"
                color="neutral"
                size="sm"
                loading={aiClearing}
                disabled={!isLive || aiClearing}
                onClick={handleClearAi}
              >
                Clear
              </JXButton>
              <JXButton
                type="button"
                variant="soft"
                color="neutral"
                size="sm"
                disabled={!isLive}
                onClick={() => void loadAiSettings()}
                startIcon={<RefreshCw className="w-3.5 h-3.5" />}
              >
                Reload
              </JXButton>
            </div>
            </form>

            {!isLive && (
              <p className="mt-3 text-xs text-[var(--product-text-tertiary)]">
                Sign in with an admin token to load and save provider settings. Until then every provider below
                shows Not configured — no keys or latencies are shown.
              </p>
            )}

          </JXCardContent>
        </JXCard>

        <JXCard>
          <JXCardContent>
            <ul className="divide-y divide-[var(--product-line)]">
              {providers.map((provider) => <li key={provider.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-[var(--product-text-secondary)]">{provider.name}</h3>
                  <p className="mt-1 break-all text-xs text-[var(--product-text-tertiary)]">{provider.defaultModel}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--product-text-tertiary)]">
                    <StatusBadge
                      status={provider.status === "configured" ? "success" : provider.status === "healthy" ? "online" : provider.status === "degraded" ? "warning" : provider.status === "offline" ? "offline" : "neutral"}
                      label={provider.status === "configured" ? "Configured" : provider.status === "healthy" ? "Reachable" : provider.status === "degraded" ? "Unreachable" : provider.status === "offline" ? "Offline" : "Not configured"}
                    />
                    <span>{provider.latencyMs != null ? `${number(provider.latencyMs)}ms` : "Not measured"}</span>
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--product-text-tertiary)]">
                    {provider.keyMasked ?? "No key configured"}
                  </p>
                  <details className="mt-2 text-xs text-[var(--product-text-tertiary)]">
                    <summary>Connection details</summary>
                    <code className="mt-2 block break-all">{provider.endpoint}</code>
                  </details>
                </div>
                <JXButton variant="outlined" color="neutral" size="sm" loading={provider.isPinging}
                  disabled={!isLive}
                  onClick={() => handlePing(provider.id)} aria-label={`Test ${provider.name}`}>Test</JXButton>
              </li>)}
            </ul>
          </JXCardContent>
        </JXCard>

          <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
            <details>
              <summary className="text-sm font-semibold text-[var(--product-text-secondary)]">Code examples</summary>
              <JXCardContent>
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)]">
                      <button
                        type="button"
                        aria-pressed={sdkLang === "python"}
                        onClick={() => setSdkLang("python")}
                        className={`px-3 py-1 rounded text-xs font-mono transition-colors ${sdkLang === "python"
                          ? "bg-indigo-600 text-white font-semibold"
                          : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                          }`}
                      >
                        Python
                      </button>
                      <button
                        type="button"
                        aria-pressed={sdkLang === "typescript"}
                        onClick={() => setSdkLang("typescript")}
                        className={`px-3 py-1 rounded text-xs font-mono transition-colors ${sdkLang === "typescript"
                          ? "bg-indigo-600 text-white font-semibold"
                          : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                          }`}
                      >
                        TypeScript
                      </button>
                      <button
                        type="button"
                        aria-pressed={sdkLang === "curl"}
                        onClick={() => setSdkLang("curl")}
                        className={`px-3 py-1 rounded text-xs font-mono transition-colors ${sdkLang === "curl"
                          ? "bg-indigo-600 text-white font-semibold"
                          : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                          }`}
                      >
                        cURL
                      </button>
                      <button
                        type="button"
                        aria-pressed={sdkLang === "mcp"}
                        onClick={() => setSdkLang("mcp")}
                        className={`px-3 py-1 rounded text-xs font-mono transition-colors ${sdkLang === "mcp"
                          ? "bg-indigo-600 text-white font-semibold"
                          : "text-[var(--product-text-tertiary)] hover:text-[var(--product-text-secondary)]"
                          }`}
                      >
                        MCP JSON-RPC
                      </button>
                    </div>

                    <JXButton
                      variant="soft"
                      color="primary"
                      size="sm"
                      onClick={handleCopyCode}
                      startIcon={
                        copiedCode ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )
                      }
                    >
                      {copiedCode ? "Copied" : "Copy Snippet"}
                    </JXButton>
                  </div>

                  <div tabIndex={0} role="region" aria-label="SDK code example" className="rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] p-4 font-mono text-xs overflow-x-auto text-[var(--product-text-secondary)] leading-relaxed max-h-[380px] overflow-y-auto">
                    <pre>
                      <code>{SDK_SNIPPETS[sdkLang]}</code>
                    </pre>
                  </div>
                </div>
              </JXCardContent>
            </details>
          </JXCard>
      </div>)}
      {activeTab === "mcp" && (<div className="space-y-4">
        {/* SECTION: Connected MCP Services & Tools */}
        <JXCard>
          <JXCardHeader
            title="Connected MCP Services & Tools"
            subheader="Connect external services (GitHub, Slack, Databases, Brave Search, or custom endpoints) using Model Context Protocol. Connected tools are callable by your 24/7 custom agents and AI copilot."
            icon={<Network className="w-4 h-4 text-emerald-400" />}
          />
          <JXCardContent>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[var(--product-text-tertiary)]">
                {isLive
                  ? `${number(mcpServers.length)} MCP service${mcpServers.length === 1 ? "" : "s"} connected (${number(mcpServers.reduce((sum, s) => sum + (s.tools_count || 0), 0))} tools discovered)`
                  : "Sign in with an admin token to manage MCP services."}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <JXButton
                  variant="contained"
                  color="primary"
                  size="sm"
                  disabled={!isLive || mcpLoading}
                  onClick={() => {
                    setMcpFormOpen((prev) => !prev);
                  }}
                  startIcon={<Plus className="w-4 h-4" />}
                >
                  {mcpFormOpen ? "Close form" : "Connect MCP service"}
                </JXButton>
                <JXButton
                  variant="soft"
                  color="neutral"
                  size="sm"
                  disabled={!isLive || mcpLoading}
                  onClick={() => void loadMcpServers()}
                  startIcon={<RefreshCw className="w-3.5 h-3.5" />}
                >
                  Reload
                </JXButton>
              </div>
            </div>

            {mcpFormOpen && (
              <form onSubmit={(event) => void handleCreateMcpServer(event)} className="mt-4 space-y-3 rounded-lg border border-[var(--product-line)] bg-[var(--product-canvas)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-[var(--product-text-secondary)]">Add MCP Connector</h3>
                  {mcpTemplates.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-[var(--product-text-tertiary)]">Presets:</span>
                      {mcpTemplates.filter((tpl) => tpl.id !== "custom-mcp").map((tpl) => (
                        <JXButton
                          key={tpl.id}
                          variant="soft"
                          color="neutral"
                          size="sm"
                          onClick={() => {
                            setMcpName(tpl.name);
                            setMcpUrl(tpl.url);
                            if (tpl.auth_type) {
                              setMcpAuthType(tpl.auth_type);
                            } else {
                              setMcpAuthType(tpl.requires_auth ? "bearer" : "none");
                            }
                            if (tpl.oauth_auth_url) setMcpOAuthAuthUrl(tpl.oauth_auth_url);
                            if (tpl.oauth_token_url) setMcpOAuthTokenUrl(tpl.oauth_token_url);
                            if (tpl.oauth_scopes) setMcpOAuthScopes(tpl.oauth_scopes);
                            if (!tpl.requires_auth) setMcpAuthToken("");
                          }}
                        >
                          {tpl.name}
                        </JXButton>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <JXTextField
                    label="Service Name"
                    value={mcpName}
                    onChange={setMcpName}
                    onBlur={() => setMcpNameTouched(true)}
                    aria-invalid={mcpNameTouched && !mcpName.trim()}
                    aria-describedby={mcpNameTouched && !mcpName.trim() ? "mcp-name-error" : undefined}
                    autoComplete="off"
                    placeholder="GitHub MCP, Slack MCP, Database MCP"
                  />
                  <JXTextField
                    label="MCP Endpoint URL (HTTP or SSE)"
                    value={mcpUrl}
                    onChange={setMcpUrl}
                    onBlur={() => setMcpUrlTouched(true)}
                    aria-invalid={mcpUrlTouched && !mcpUrl.trim()}
                    aria-describedby={mcpUrlTouched && !mcpUrl.trim() ? "mcp-url-error" : undefined}
                    autoComplete="url"
                    placeholder="http://mcp-http:8001 or https://api.service.com/mcp"
                  />
                  <JXSelect
                    label="Authentication Mode"
                    value={mcpAuthType}
                    onChange={setMcpAuthType}
                    options={[
                      { id: "bearer", label: "Bearer Token / API Key" },
                      { id: "oauth2_pkce", label: "OAuth 2.0 / 2.1 (Browser Login + PKCE)" },
                      { id: "oauth2_client_credentials", label: "OAuth 2.0 (Client Credentials M2M)" },
                      { id: "none", label: "No Authentication" },
                    ]}
                  />

                  {mcpAuthType === "bearer" && (
                    <div>
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <JXTextField
                            label="Authentication Token (Optional)"
                            type={showMcpToken ? "text" : "password"}
                            value={mcpAuthToken}
                            onChange={setMcpAuthToken}
                            clearable={false}
                            autoComplete="off"
                            placeholder="Bearer token or API key if required"
                          />
                        </div>
                        <JXButton type="button" variant="outlined" color="neutral" size="sm" className="mt-6 min-h-11 shrink-0"
                          aria-pressed={showMcpToken} aria-label={showMcpToken ? "Hide bearer token" : "Show bearer token"}
                          title={showMcpToken ? "Hide bearer token" : "Show bearer token"}
                          onClick={() => setShowMcpToken((prev) => !prev)}>
                          {showMcpToken ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                        </JXButton>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-[var(--product-text-tertiary)]">Sent only to the MCP endpoint above, as a bearer token. It is stored on the control plane, never shown in full here.</p>
                    </div>
                  )}

                  {mcpAuthType === "oauth2_pkce" && (
                    <div className="flex items-end">
                      <JXButton
                        type="button"
                        variant="outlined"
                        color="neutral"
                        size="sm"
                        loading={mcpDiscovering}
                        disabled={!mcpUrl.trim() || mcpDiscovering}
                        onClick={() => void handleDiscoverMcpOAuth()}
                        startIcon={<Globe className="w-3.5 h-3.5" />}
                      >
                        Auto-discover OAuth2 endpoints
                      </JXButton>
                    </div>
                  )}

                  {(mcpAuthType === "oauth2_pkce" || mcpAuthType === "oauth2_client_credentials") && (
                    <>
                      {mcpAuthType === "oauth2_pkce" && (
                        <JXTextField
                          label="Authorization URL (optional if auto-discovered)"
                          autoComplete="url"
                          value={mcpOAuthAuthUrl}
                          onChange={setMcpOAuthAuthUrl}
                          placeholder="https://provider.com/oauth/authorize"
                        />
                      )}
                      <JXTextField
                        label="Token URL (optional if auto-discovered)"
                        autoComplete="url"
                        value={mcpOAuthTokenUrl}
                        onChange={setMcpOAuthTokenUrl}
                        placeholder="https://provider.com/oauth/token"
                      />
                      <JXTextField
                        label={mcpAuthType === "oauth2_pkce" ? "Client ID (optional with Dynamic Registration)" : "Client ID"}
                        autoComplete="off"
                        value={mcpOAuthClientId}
                        onChange={setMcpOAuthClientId}
                        placeholder="client_id"
                      />
                      <div>
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <JXTextField
                              label={mcpAuthType === "oauth2_pkce" ? "Client Secret (optional for public PKCE)" : "Client Secret"}
                              type={showMcpSecret ? "text" : "password"}
                              value={mcpOAuthClientSecret}
                              onChange={setMcpOAuthClientSecret}
                              clearable={false}
                              autoComplete="new-password"
                              placeholder="client_secret"
                            />
                          </div>
                          <JXButton type="button" variant="outlined" color="neutral" size="sm" className="mt-6 min-h-11 shrink-0"
                            aria-pressed={showMcpSecret} aria-label={showMcpSecret ? "Hide client secret" : "Show client secret"}
                            title={showMcpSecret ? "Hide client secret" : "Show client secret"}
                            onClick={() => setShowMcpSecret((prev) => !prev)}>
                            {showMcpSecret ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                          </JXButton>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-[var(--product-text-tertiary)]">The OAuth client secret for this MCP service. It is exchanged only with the token URL above and stored on the control plane.</p>
                      </div>
                      <div className="md:col-span-2">
                        <JXTextField
                          label="Scopes (optional, space-separated)"
                          autoComplete="off"
                          value={mcpOAuthScopes}
                          onChange={setMcpOAuthScopes}
                          placeholder="read write mcp:tools"
                        />
                      </div>
                    </>
                  )}
                </div>

                {(mcpNameTouched && !mcpName.trim()) && (
                  <p id="mcp-name-error" role="alert" className="text-[11px] text-amber-300">A service name is required.</p>
                )}
                {(mcpUrlTouched && !mcpUrl.trim()) && (
                  <p id="mcp-url-error" role="alert" className="text-[11px] text-amber-300">An MCP endpoint URL is required.</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <JXButton
                    type="submit"
                    variant="contained"
                    color="primary"
                    size="sm"
                    loading={mcpLoading}
                    disabled={!isLive || mcpLoading || !mcpName.trim() || !mcpUrl.trim()}
                    startIcon={mcpAuthType === "oauth2_pkce" ? <KeyRound className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                  >
                    {mcpAuthType === "oauth2_pkce" ? "Save & Authorize with OAuth2" : "Connect & probe tools"}
                  </JXButton>
                  <JXButton type="button" variant="text" color="neutral" size="sm" onClick={() => setMcpFormOpen(false)}>
                    Cancel
                  </JXButton>
                </div>
              </form>
            )}


            {mcpServers.length === 0 ? (
              <EmptyState
                variant="card"
                title="No external MCP services connected"
                description="Click Connect MCP service to add GitHub, Slack, local AI Bridge Fleet, or custom tool endpoints."
                actionLabel="Add Built-in Fleet MCP"
                onAction={() => {
                  setMcpName("Local AI Bridge Fleet MCP");
                  setMcpUrl("http://mcp-http:8001");
                  setMcpFormOpen(true);
                }}
              />
            ) : (
              <ul className="mt-4 divide-y divide-[var(--product-line)]">
                {mcpServers.map((srv) => (
                  <li key={srv.id} className="py-3 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium text-[var(--product-text-secondary)]">{srv.name}</h3>
                        <StatusBadge
                          status={srv.status === "healthy" ? "online" : srv.status === "pending_auth" ? "warning" : srv.status === "offline" ? "offline" : "unknown"}
                          label={srv.status === "healthy" ? "Connected" : srv.status === "pending_auth" ? "Auth Required" : srv.status === "offline" ? "Offline" : "Unknown"}
                        />
                        {srv.auth_type && srv.auth_type.startsWith("oauth2") && (
                          <StatusBadge
                            status={srv.oauth_connected ? "success" : "warning"}
                            label={srv.auth_type === "oauth2_client_credentials" ? "OAuth2 M2M" : srv.oauth_connected ? "OAuth2 Authorized" : "OAuth2 Pending"}
                          />
                        )}
                        <JXBadge
                          color="primary"
                          statusText={`${srv.tools_count || 0} tool${srv.tools_count === 1 ? "" : "s"}`}
                        />
                        <span className="font-mono text-xs text-[var(--product-text-tertiary)] break-all">{srv.url}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {(srv.auth_type === "oauth2_pkce" || srv.status === "pending_auth") && (
                          <JXButton
                            variant="contained"
                            color="primary"
                            size="sm"
                            disabled={mcpLoading}
                            onClick={() => void handleStartMcpOAuth(srv.id)}
                            startIcon={<KeyRound className="w-3.5 h-3.5" />}
                          >
                            {srv.oauth_connected ? "Re-authorize" : "Connect OAuth2"}
                          </JXButton>
                        )}
                        <JXButton
                          variant="outlined"
                          color="neutral"
                          size="sm"
                          loading={mcpSyncing[srv.id]}
                          disabled={mcpLoading}
                          onClick={() => void handleSyncMcpServer(srv.id)}
                          startIcon={<RefreshCw className="w-3.5 h-3.5" />}
                        >
                          Sync tools
                        </JXButton>
                        <JXButton
                          variant="text"
                          color="neutral"
                          size="sm"
                          onClick={() =>
                            setMcpToolsExpanded((prev) => ({ ...prev, [srv.id]: !prev[srv.id] }))
                          }
                          startIcon={
                            mcpToolsExpanded[srv.id] ? (
                              <ChevronUp className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5" />
                            )
                          }
                        >
                          {mcpToolsExpanded[srv.id] ? "Hide tools" : "View tools"}
                        </JXButton>
                        <JXButton
                          variant="outlined"
                          color="neutral"
                          size="sm"
                          disabled={mcpLoading}
                          onClick={() => void handleToggleMcpServer(srv)}
                        >
                          {srv.enabled ? "Disable" : "Enable"}
                        </JXButton>
                        <JXButton
                          variant="text"
                          color="error"
                          size="sm"
                          disabled={mcpLoading}
                          onClick={() => setDeleteMcpConfirm(srv)}
                          startIcon={<Trash2 className="w-3.5 h-3.5" />}
                        >
                          Remove
                        </JXButton>
                      </div>
                    </div>

                    {srv.last_error && <p className="text-xs text-[var(--product-danger)]">{srv.last_error}</p>}

                    {mcpToolsExpanded[srv.id] && (
                      <div className="mt-2 rounded-lg border border-[var(--product-line)] bg-[var(--product-canvas)] p-3 space-y-2">
                        <h4 className="text-xs font-semibold text-[var(--product-text-secondary)]">
                          Discovered Tools ({srv.tools?.length || 0})
                        </h4>
                        {(!srv.tools || srv.tools.length === 0) ? (
                          <EmptyState variant="bare" title="No tools discovered yet"
                            description="Click Sync tools to probe this MCP service." />
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-56 overflow-y-auto">
                            {srv.tools.map((t) => {
                              const policyKey = `${srv.id}:${t.name}`;
                              const curPolicy = mcpToolPolicies[policyKey] || "allow";
                              return (
                                <div key={t.name} className="p-2 rounded border border-[var(--product-line)] bg-[var(--product-surface)] space-y-1.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="font-mono text-xs font-semibold text-indigo-300 truncate">
                                      mcp__{srv.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}__{t.name}
                                    </p>
                                    <div className="flex items-center gap-1.5">
                                      <JXButton
                                        variant="outlined"
                                        color="primary"
                                        size="sm"
                                        disabled={mcpLoading}
                                        onClick={() => void handleTestMcpTool(srv.id, t.name)}
                                      >
                                        Run
                                      </JXButton>
                                      <select
                                        aria-label={`Policy for ${t.name}`}
                                        value={curPolicy}
                                        onChange={(e) => void handleMcpPolicyChange(srv.id, t.name, e.target.value)}
                                        className="rounded bg-[var(--product-canvas)] border border-[var(--product-line)] px-1.5 py-0.5 text-[11px] font-mono text-[var(--product-text-secondary)]"
                                      >
                                        <option value="allow">Allow</option>
                                        <option value="require_approval">Require approval</option>
                                        <option value="deny">Deny</option>
                                      </select>
                                    </div>
                                  </div>
                                  <p className="text-xs text-[var(--product-text-tertiary)] line-clamp-2">{t.description}</p>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </JXCardContent>
        </JXCard>
      </div>)}
      {activeTab === "agents" && (<div className="space-y-4">
        <JXCard>
          <JXCardHeader
            title="Custom 24/7 agents"
            subheader="Bind an objective to a connected AI provider and enrolled devices. While this control plane is online, each enabled agent keeps running on its own interval."
            icon={<Bot className="w-4 h-4" />}
          />
          <JXCardContent>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[var(--product-text-tertiary)]">
                {isLive
                  ? `${number(agents.length)} agent${agents.length === 1 ? "" : "s"} configured`
                  : "Sign in with an admin token to create and run agents."}
              </p>
              <JXButton
                variant="contained"
                color="primary"
                size="sm"
                disabled={!isLive || agentBusy}
                onClick={openAgentForm}
                startIcon={<Bot className="w-4 h-4" />}
              >
                New agent
              </JXButton>
            </div>

            {agents.length === 0 ? (
              <EmptyState variant="bare" title="No custom agents yet"
                description="Create one and it will start working through its objective on your devices." />
            ) : (
              <ul className="mt-3 divide-y divide-[var(--product-line)]">
                {agents.map((agent) => (
                  <li key={agent.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-medium text-[var(--product-text-secondary)]">{agent.name}</h3>
                        <StatusBadge
                          status={agent.status === "running" ? "running" : agent.status === "error" ? "error" : agent.enabled ? "active" : "paused"}
                          label={agent.status === "running" ? "Running" : agent.status === "error" ? "Error" : agent.enabled ? "Active" : "Paused"}
                        />
                        <span className="text-xs text-[var(--product-text-tertiary)]">
                          {agent.provider}{agent.model ? ` \u00b7 ${agent.model}` : ""}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <JXButton
                          variant="outlined"
                          color="neutral"
                          size="sm"
                          disabled={agentBusy}
                          onClick={() => handleEditAgent(agent)}
                          startIcon={<Pencil className="w-3.5 h-3.5" />}
                        >
                          Edit
                        </JXButton>
                        <JXButton
                          variant="outlined"
                          color="neutral"
                          size="sm"
                          disabled={agentBusy}
                          onClick={() => void handleToggleAgent(agent)}
                          startIcon={agent.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                        >
                          {agent.enabled ? "Pause" : "Start"}
                        </JXButton>
                        <JXButton
                          variant="soft"
                          color="neutral"
                          size="sm"
                          disabled={agentBusy || !agent.enabled}
                          onClick={() => void handleRunAgent(agent)}
                          startIcon={<Zap className="w-3.5 h-3.5" />}
                        >
                          Run now
                        </JXButton>
                        <JXButton
                          variant="outlined"
                          color="primary"
                          size="sm"
                          disabled={agentBusy}
                          onClick={() => { setAskTargetAgent(agent); setAskPrompt(""); setAskResult(null); }}
                          startIcon={<Send className="w-3.5 h-3.5" />}
                        >
                          Ask
                        </JXButton>
                        <JXButton
                          variant="text"
                          color="error"
                          size="sm"
                          disabled={agentBusy}
                          onClick={() => setDeleteAgentConfirm(agent)}
                          startIcon={<Trash2 className="w-3.5 h-3.5" />}
                        >
                          Delete
                        </JXButton>
                      </div>
                    </div>
                    <p className="text-xs text-[var(--product-text-tertiary)]">
                      {agent.devices.map((device) => device.name || device.hostname || device.id).join(", ")}
                      {" \u00b7 "}{formatInterval(agent.interval_seconds)}
                      {" \u00b7 "}{number(agent.run_count)} run{agent.run_count === 1 ? "" : "s"}
                      {" \u00b7 "}last {relativeTime(agent.last_run_at, locale)}
                    </p>
                    {agent.mcp_servers && agent.mcp_servers.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-[11px] text-[var(--product-text-tertiary)] flex items-center gap-1">
                          <Network className="w-3 h-3 text-emerald-400" /> MCP:
                        </span>
                        {agent.mcp_servers.map((s) => (
                          <JXBadge
                            key={s.id}
                            color="primary"
                            statusText={`${s.name} (${s.tools_count} tools)`}
                          />
                        ))}
                      </div>
                    )}
                    {agent.last_error ? (
                      <p className="text-xs text-[var(--product-danger)]">Last error: {agent.last_error}</p>
                    ) : agent.last_result ? (
                      <p className="line-clamp-2 text-xs text-[var(--product-text-tertiary)]">{agent.last_result}</p>
                    ) : null}
                    {(agent.consecutive_failures || 0) > 0 && (
                      <p className="text-xs text-amber-400">
                        Consecutive failures: {agent.consecutive_failures} (auto-pauses at 5)
                      </p>
                    )}
                    {agent.memory ? (
                      <div className="mt-1">
                        <p className="line-clamp-3 text-xs text-indigo-300">Memory: {agent.memory}</p>
                        <div className="flex items-center gap-2">
                          <JXButton
                            variant="text"
                            color="neutral"
                            size="sm"
                            disabled={agentBusy}
                            onClick={() => openMemoryEditor(agent)}
                          >
                            Edit memory
                          </JXButton>
                          <JXButton
                            variant="text"
                            color="neutral"
                            size="sm"
                            disabled={agentBusy}
                            onClick={() => void handleClearAgentMemory(agent)}
                          >
                            Clear memory
                          </JXButton>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1">
                        <JXButton
                          variant="text"
                          color="neutral"
                          size="sm"
                          disabled={agentBusy}
                          onClick={() => openMemoryEditor(agent)}
                        >
                          Add pinned memory
                        </JXButton>
                      </div>
                    )}
                    <div className="mt-2">
                      <JXButton
                        variant="text"
                        color="neutral"
                        size="sm"
                        onClick={() => void handleToggleAgentRuns(agent)}
                        startIcon={agentRunsOpen[agent.id] ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      >
                        Recent runs
                      </JXButton>
                      {agentRunsOpen[agent.id] && (
                        <div className="mt-2 space-y-2 rounded-lg border border-[var(--product-line)] bg-[var(--product-canvas)] p-3">
                          {agentRunsLoading[agent.id] ? (
                            <p className="text-xs text-[var(--product-text-tertiary)]">Loading runs…</p>
                          ) : (agentRuns[agent.id] || []).length === 0 ? (
                            <EmptyState variant="bare" title="No runs yet."
                              description="Runs appear here after the agent's next cycle, or use Run now." />
                          ) : (
                            <ul className="space-y-2">
                              {(agentRuns[agent.id] || []).slice(0, 10).map((run: any) => (
                                <li key={run.id} className="rounded border border-[var(--product-line)] p-2 text-xs">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <StatusBadge status={run.status} />
                                    <span className="text-[var(--product-text-tertiary)]">
                                      {run.started_at ? date(new Date(run.started_at * 1000), { dateStyle: "medium", timeStyle: "short" }) : ""}
                                    </span>
                                    {run.duration_ms != null && (
                                      <span className="text-[var(--product-text-tertiary)]">{number(run.duration_ms)} ms</span>
                                    )}
                                  </div>
                                  {run.error ? (
                                    <p className="mt-1 text-[var(--product-danger)]">{run.error}</p>
                                  ) : run.response ? (
                                    <p className="mt-1 line-clamp-3 text-[var(--product-text-tertiary)]">{run.response}</p>
                                  ) : null}
                                  {Array.isArray(run.steps) && run.steps.length > 0 && (
                                    <div className="mt-1.5">
                                      <button
                                        type="button"
                                        onClick={() => setExpandedRunTrace((prev) => ({ ...prev, [run.id]: !prev[run.id] }))}
                                        className="font-mono text-[11px] text-indigo-400 hover:underline"
                                      >
                                        {expandedRunTrace[run.id] ? "Hide" : "View"} tool trace ({run.steps.length} step{run.steps.length === 1 ? "" : "s"})
                                      </button>
                                      {expandedRunTrace[run.id] && (
                                        <div className="mt-1.5 space-y-1.5 border-l-2 border-indigo-500/40 pl-2">
                                          {run.steps.map((st: any, idx: number) => (
                                            <div key={idx} className="rounded bg-[var(--product-surface)] p-1.5 font-mono text-[11px]">
                                              <div className="flex items-center justify-between text-indigo-300 gap-2 flex-wrap">
                                                <span className="flex items-center gap-1.5">
                                                  <span>{idx + 1}. {st.tool}</span>
                                                  {st.tool === "agent_delegate" && st.result?.agent_name && (
                                                    <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 text-[11px]">
                                                      Delegated → {st.result.agent_name}
                                                    </span>
                                                  )}
                                                  {st.tool === "agent_run_workflow" && st.result?.workflow_id && (
                                                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[11px]">
                                                      Workflow {st.result.workflow_id} ({st.result.status || "ran"})
                                                    </span>
                                                  )}
                                                </span>
                                                <span className="text-[11px] text-[var(--product-text-dim)]">{st.device || "local"}</span>
                                              </div>
                                              {st.args && Object.keys(st.args).length > 0 && (
                                                <pre className="mt-0.5 text-[11px] text-[var(--product-text-tertiary)] overflow-x-auto">{JSON.stringify(st.args)}</pre>
                                              )}
                                              {st.result !== undefined && (
                                                <pre className="mt-0.5 text-[11px] text-emerald-300/90 overflow-x-auto max-h-24">{typeof st.result === "string" ? st.result : JSON.stringify(st.result)}</pre>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {agentFormOpen && (
              <form onSubmit={(event) => void handleSaveAgent(event)} className="mt-4 space-y-3 rounded-lg border border-[var(--product-line)] bg-[var(--product-canvas)] p-4">
                <div className="flex items-center justify-between border-b border-[var(--product-line)] pb-2.5">
                  <div className="flex items-center gap-2">
                    {editingAgentId ? <Pencil className="w-4 h-4 text-primary-400" /> : <Bot className="w-4 h-4 text-primary-400" />}
                    <span className="text-sm font-semibold text-[var(--product-text-primary)]">
                      {editingAgentId ? `Edit Agent: ${agentName || "Untitled"}` : "Configure 24/7 autonomous agent"}
                    </span>
                  </div>
                  <JXButton variant="text" color="neutral" size="sm" onClick={handleCloseAgentForm}>
                    <X className="w-4 h-4" />
                  </JXButton>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <JXTextField
                    label="Agent name"
                    autoComplete="off"
                    value={agentName}
                    onChange={setAgentName}
                    placeholder="Nightly fleet health check"
                  />
                  <JXSelect
                    label="Connected AI"
                    options={AI_PROVIDER_OPTIONS}
                    value={agentProvider}
                    onChange={(value) => {
                      setAgentProvider(value);
                      if (value === "custom") {
                        setAgentBaseUrl(aiSettings?.custom_base_url || "");
                        setAgentModel(aiSettings?.custom_model || "");
                      } else {
                        setAgentModel(aiSettings?.model || "");
                      }
                    }}
                  />
                  <JXTextField
                    label="Model (optional)"
                    autoComplete="off"
                    value={agentModel}
                    onChange={setAgentModel}
                    placeholder={agentProvider === "custom" ? "Provider default" : "gpt-4o"}
                  />
                  <JXSelect
                    label="Run interval"
                    options={AGENT_INTERVAL_OPTIONS}
                    value={agentInterval}
                    onChange={setAgentInterval}
                  />
                </div>

                {agentProvider === "custom" && (
                  <JXTextField
                    label="Custom AI base URL"
                    autoComplete="url"
                    value={agentBaseUrl}
                    onChange={setAgentBaseUrl}
                    placeholder="https://openrouter.ai/api/v1"
                  />
                )}

                <div>
                  <label htmlFor="agent-objective" className="mb-1 block text-xs font-mono text-[var(--product-text-tertiary)]">
                    Objective / instructions
                  </label>
                  <textarea
                    id="agent-objective"
                    aria-label="Agent objective"
                    autoComplete="off"
                    rows={4}
                    value={agentInstruction}
                    onChange={(event) => setAgentInstruction(event.target.value)}
                    placeholder="Check disk usage on every bound device, clean safe caches above 85%, and report anything that needs a human."
                    className="w-full resize-none rounded-lg border border-[var(--product-line)] bg-[var(--product-surface)] p-3 text-xs text-[var(--product-text-secondary)] focus:outline-none"
                  />
                </div>

                <div>
                  <p className="mb-1 text-xs font-mono text-[var(--product-text-tertiary)]">Bound devices ({agentDeviceIds.length} selected)</p>
                  <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto md:grid-cols-2">
                    {devices.map((device) => (
                      <label key={device.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-[var(--product-text-secondary)] hover:bg-[var(--product-surface)]">
                        <input
                          type="checkbox"
                          checked={agentDeviceIds.includes(device.id)}
                          onChange={(event) =>
                            setAgentDeviceIds((previous) =>
                              event.target.checked
                                ? [...previous, device.id]
                                : previous.filter((id) => id !== device.id)
                            )
                          }
                        />
                        <span className="truncate">
                          {device.name}{" "}
                          <span className="text-[var(--product-text-tertiary)]">({device.hostname})</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {mcpServers.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs font-mono text-[var(--product-text-tertiary)] flex items-center gap-1">
                        <Network className="w-3.5 h-3.5 text-emerald-400" />
                        Connected MCP Services ({agentMcpServerIds.length} enabled)
                      </p>
                      <JXButton
                        type="button"
                        variant="text"
                        color="primary"
                        size="sm"
                        onClick={() =>
                          setAgentMcpServerIds(
                            agentMcpServerIds.length === mcpServers.length
                              ? []
                              : mcpServers.map((s) => s.id)
                          )
                        }
                      >
                        {agentMcpServerIds.length === mcpServers.length ? "Deselect all" : "Select all"}
                      </JXButton>
                    </div>
                    <div className="grid max-h-36 grid-cols-1 gap-1 overflow-y-auto md:grid-cols-2">
                      {mcpServers.map((srv) => (
                        <label key={srv.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-[var(--product-text-secondary)] hover:bg-[var(--product-surface)]">
                          <input
                            type="checkbox"
                            checked={agentMcpServerIds.includes(srv.id)}
                            onChange={(e) =>
                              setAgentMcpServerIds((prev) =>
                                e.target.checked ? [...prev, srv.id] : prev.filter((id) => id !== srv.id)
                              )
                            }
                          />
                          <span className="truncate">
                            {srv.name}{" "}
                            <span className="text-[var(--product-text-tertiary)]">({srv.tools_count} tools)</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-mono text-[var(--product-text-tertiary)] flex items-center gap-1">
                      <Wrench className="w-3.5 h-3.5 text-indigo-400" />
                      Device Tools Scope ({agentAllowedTools.length === 0 ? "All 49 device tools (default)" : `${agentAllowedTools.length} selected`})
                    </p>
                    {agentAllowedTools.length > 0 && (
                      <JXButton
                        type="button"
                        variant="text"
                        color="primary"
                        size="sm"
                        onClick={() => setAgentAllowedTools([])}
                      >
                        Reset to All Tools
                      </JXButton>
                    )}
                  </div>
                  <div className="grid max-h-36 grid-cols-1 gap-1 overflow-y-auto md:grid-cols-2">
                    {DEVICE_TOOL_OPTIONS.map((t) => (
                      <label key={t.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-[var(--product-text-secondary)] hover:bg-[var(--product-surface)]">
                        <input
                          type="checkbox"
                          checked={agentAllowedTools.length === 0 || agentAllowedTools.includes(t.id)}
                          onChange={(e) => {
                            if (agentAllowedTools.length === 0) {
                              if (!e.target.checked) {
                                setAgentAllowedTools(DEVICE_TOOL_OPTIONS.filter((item) => item.id !== t.id).map((item) => item.id));
                              }
                            } else {
                              setAgentAllowedTools((prev) =>
                                e.target.checked ? [...prev, t.id] : prev.filter((id) => id !== t.id)
                              );
                            }
                          }}
                        />
                        <span className="truncate font-mono text-[11px]">{t.id} <span className="text-[var(--product-text-tertiary)] font-sans">({t.label})</span></span>
                      </label>
                    ))}
                  </div>
                </div>

                {editingAgentId && (
                  <div>
                    <label htmlFor="agent-memory-notes" className="mb-1 block text-xs font-mono text-[var(--product-text-tertiary)]">
                      Agent persistent memory / notes
                    </label>
                    <textarea
                      id="agent-memory-notes"
                      aria-label="Agent memory"
                      autoComplete="off"
                      rows={2}
                      value={agentMemory}
                      onChange={(e) => setAgentMemory(e.target.value)}
                      placeholder="Agent memory or persistent operational state..."
                      className="w-full resize-none rounded-lg border border-[var(--product-line)] bg-[var(--product-surface)] p-3 text-xs text-[var(--product-text-secondary)] focus:outline-none"
                    />
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <JXButton
                    type="submit"
                    variant="contained"
                    color="primary"
                    size="md"
                    loading={agentBusy}
                    disabled={!isLive || agentBusy || !agentName.trim() || !agentInstruction.trim() || agentDeviceIds.length === 0}
                    startIcon={editingAgentId ? <Check className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
                  >
                    {editingAgentId ? "Update agent" : "Create 24/7 agent"}
                  </JXButton>
                  <JXButton type="button" variant="text" color="neutral" size="sm" onClick={handleCloseAgentForm}>
                    Cancel
                  </JXButton>
                  <span className="flex items-center gap-1 text-xs text-[var(--product-text-tertiary)]">
                    <Clock3 className="w-3.5 h-3.5" /> {editingAgentId ? "Updates apply on the agent's next cycle." : "Repeats until you pause or delete it."}
                  </span>
                </div>
              </form>
            )}

          </JXCardContent>
        </JXCard>
      </div>)}
      {activeTab === "chat" && (<div className="space-y-4">
          <JXCard className="bg-[var(--product-surface)]/70 border-[var(--product-line)]">
            <JXCardHeader
              title="AI Copilot Chat"
              subheader="Multi-turn troubleshooting & research across connected devices and active OAuth2/MCP servers"
              icon={<MessageSquare className="w-5 h-5 text-cyan-400" />}
            />
            <JXCardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <JXBadge color="info">
                    {mcpServers.filter((s) => s.enabled).length} active MCP
                  </JXBadge>
                  {copilotMessages.length > 0 && (
                    <JXButton
                      variant="text"
                      size="sm"
                      onClick={handleCopilotClear}
                      disabled={copilotBusy}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1" />
                      Clear
                    </JXButton>
                  )}
                </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="copilot-device" className="block text-[11px] uppercase tracking-wider text-[var(--product-text-tertiary)] mb-1">
                    Target Device (Optional)
                  </label>
                  <select
                    id="copilot-device"
                    aria-label="Copilot Target Device"
                    value={copilotDevice}
                    onChange={(e) => setCopilotDevice(e.target.value)}
                    className="w-full rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] px-3 py-2 text-xs text-[var(--product-text-secondary)] focus:outline-none focus:border-cyan-400/60"
                  >
                    <option value="">Auto / All fleet & MCP tools</option>
                    {devices.map((dev) => (
                      <option key={dev.id} value={dev.id}>
                        {dev.hostname || dev.id} ({dev.status})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="copilot-provider" className="block text-[11px] uppercase tracking-wider text-[var(--product-text-tertiary)] mb-1">
                    Model Provider Override
                  </label>
                  <select
                    id="copilot-provider"
                    aria-label="Copilot Provider"
                    value={copilotProvider}
                    onChange={(e) => setCopilotProvider(e.target.value)}
                    className="w-full rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] px-3 py-2 text-xs text-[var(--product-text-secondary)] focus:outline-none focus:border-cyan-400/60"
                  >
                    <option value="">Default configured provider</option>
                    <option value="anthropic">Anthropic Claude</option>
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="custom">Custom OpenAI-Compatible</option>
                  </select>
                </div>
              </div>

              {mcpServers.filter((s) => s.enabled).length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--product-text-tertiary)]">
                  <span>Active MCP connectors:</span>
                  {mcpServers
                    .filter((s) => s.enabled)
                    .map((srv) => (
                      <JXBadge key={srv.id} color="default">
                        {srv.name} ({srv.tools_count || 0} tools)
                      </JXBadge>
                    ))}
                </div>
              )}

              {copilotBusy && copilotLiveEvents.length > 0 && (
                <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/20 px-3 py-2 space-y-1 text-[11px] font-mono">
                  <div className="text-cyan-300 font-semibold">Live tool execution:</div>
                  {copilotLiveEvents.map((ev, i) => (
                    <div key={i} className="flex items-center justify-between text-[var(--product-text-secondary)]">
                      <span>{ev.step ? `Step ${ev.step}: ` : ""}{ev.tool} ({ev.device || "local"})</span>
                      <span className={ev.status === "done" ? "text-emerald-400" : ev.status === "error" ? "text-rose-400" : "text-amber-300"}>
                        {ev.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-xl border border-[var(--product-line)] bg-[var(--product-canvas)] p-3 max-h-96 overflow-y-auto space-y-3">
                {copilotMessages.length === 0 ? (
                  <EmptyState variant="bare" title="Ask the Copilot"
                    description="Ask it to inspect a device, search docs via Firecrawl MCP, or run diagnostics." />
                ) : (
                  copilotMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`rounded-xl p-3 text-xs border ${msg.role === "user"
                        ? "bg-indigo-500/10 border-indigo-500/30 text-[var(--product-text)] ml-6"
                        : "bg-[var(--product-surface)] border-[var(--product-line)] text-[var(--product-text-secondary)] mr-6"
                        }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1 text-[11px] uppercase tracking-wider text-[var(--product-text-tertiary)]">
                        <span>{msg.role === "user" ? "You" : "Copilot"}</span>
                        {msg.model && (
                          <span className="font-mono text-[var(--product-text-dim)]">
                            {msg.provider ? `${msg.provider}: ` : ""}
                            {msg.model}
                          </span>
                        )}
                      </div>
                      <div className="whitespace-pre-wrap leading-relaxed">
                        {msg.content}
                      </div>
                      {msg.steps && msg.steps.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-[var(--product-line)]/60">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <JXButton
                              type="button"
                              variant="text"
                              color="primary"
                              size="sm"
                              onClick={() =>
                                setCopilotExpandedSteps((prev) => ({
                                  ...prev,
                                  [msg.id]: !prev[msg.id],
                                }))
                              }
                            >
                              {copilotExpandedSteps[msg.id] ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                              {msg.steps.length} tool call{msg.steps.length === 1 ? "" : "s"}
                            </JXButton>
                            <JXButton
                              type="button"
                              variant="text"
                              color="primary"
                              size="sm"
                              onClick={() => void handleSaveCopilotAsWorkflow(msg)}
                            >
                              Save as Workflow
                            </JXButton>
                          </div>
                          {copilotExpandedSteps[msg.id] && (
                            <pre className="mt-2 p-2 rounded-lg bg-[var(--product-canvas)] text-[11px] text-[var(--product-text-secondary)] overflow-x-auto max-h-48">
                              {JSON.stringify(msg.steps, null, 2)}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              <form onSubmit={handleCopilotSend} className="flex items-center gap-2">
                <input
                  type="text"
                  aria-label="Ask Copilot"
                  autoComplete="off"
                  value={copilotInput}
                  onChange={(e) => setCopilotInput(e.target.value)}
                  placeholder="Ask Copilot anything (uses connected devices & enabled MCP servers)..."
                  disabled={copilotBusy}
                  className="flex-1 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] px-3 py-2 text-xs text-[var(--product-text)] placeholder:text-[var(--product-text-dim)] focus:outline-none focus:border-cyan-400/60"
                />
                <JXButton
                  type="submit"
                  variant="contained"
                  size="sm"
                  disabled={copilotBusy || !copilotInput.trim()}
                >
                  <Send className="w-3.5 h-3.5 mr-1.5" />
                  {copilotBusy ? "Thinking..." : "Send"}
                </JXButton>
              </form>
              </div>
            </JXCardContent>
          </JXCard>

          <JXCard className="bg-[var(--product-surface)]/60 border-[var(--product-line)]">
            <JXCardHeader
              title="Try a tool"
              icon={<Terminal className="w-5 h-5 text-indigo-400" />}
            />
            <JXCardContent>
              <form onSubmit={(event) => void handleExecuteTool(event)} className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="try-tool-device" className="block text-xs font-mono text-[var(--product-text-tertiary)] mb-1">
                      Device
                    </label>
                    <select
                      id="try-tool-device"
                      aria-label="Target device"
                      value={selectedNode}
                      onChange={(e) => setSelectedNode(e.target.value)}
                      className="w-full p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text-secondary)] focus:outline-none"
                    >
                      {(aiFleetDevices.length > 0 ? aiFleetDevices : devices).map((d: any) => (
                        <option key={d.id} value={d.id}>
                          {d.hostname || d.name || d.id} ({d.platform || d.status || "device"})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="try-tool-model" className="block text-xs font-mono text-[var(--product-text-tertiary)] mb-1">
                      Model
                    </label>
                    <select
                      id="try-tool-model"
                      aria-label="Reasoning model"
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="w-full p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text-secondary)] focus:outline-none"
                    >
                      <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                      <option value="gpt-4o">OpenAI GPT-4o</option>
                      <option value="gemini-1.5-pro">Google Gemini 1.5 Pro</option>
                      <option value="llama3.1:8b-instruct">Local Llama 3.1 8B</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="try-tool-tool" className="block text-xs font-mono text-[var(--product-text-tertiary)] mb-1">
                    Tool
                  </label>
                  <select
                    id="try-tool-tool"
                    aria-label="Exposed tool primitive"
                    value={selectedTool}
                    onChange={(e) => setSelectedTool(e.target.value)}
                    className="w-full p-2 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] text-xs font-mono text-[var(--product-text-secondary)] focus:outline-none"
                  >
                    <option value="desktop_get_screenshot">desktop_get_screenshot (SoM Visual)</option>
                    <option value="run_shell">run_shell (Elevated Command Execution)</option>
                    <option value="get_system_info">get_system_info (Hardware Telemetry)</option>
                    <option value="list_devices">list_devices (Fleet Inventory)</option>
                    <option value="ai_agent">ai_agent (Autonomous Objective)</option>
                    {aiCatalogTools
                      .filter((name) => !["desktop_get_screenshot", "run_shell", "get_system_info", "list_devices"].includes(name))
                      .map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="try-tool-args" className="block text-xs font-mono text-[var(--product-text-tertiary)] mb-1">
                    Arguments (JSON)
                  </label>
                  <textarea
                    id="try-tool-args"
                    aria-label="Tool arguments JSON"
                    autoComplete="off"
                    rows={4}
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    className="w-full p-3 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] font-mono text-xs text-[var(--product-text-secondary)] focus:outline-none resize-none"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <JXButton
                    type="submit"
                    variant="contained"
                    color="primary"
                    size="md"
                    loading={isExecuting}
                    startIcon={<Play className="w-4 h-4" />}
                  >
                    {isLive ? "Execute" : "Run sample (demo — runs nothing)"}
                  </JXButton>
                </div>

                {/* Return Schema Response Viewer */}
                {executionResult && (
                  <div className="p-3 rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-mono border-b border-[var(--product-line)]/80 pb-2">
                      <span className="flex items-center gap-1.5 font-semibold">
                        <StatusBadge status={executionResult.status} />
                        <span className="text-[var(--product-text-tertiary)]">({number(executionResult.durationMs)}ms)</span>
                      </span>
                      <span className="text-[var(--product-text-tertiary)]">
                        {number(executionResult.tokens.input)} in / {number(executionResult.tokens.output)} out ({executionResult.tokens.cost})
                      </span>
                    </div>
                    <pre tabIndex={0} aria-label="Tool response" className="text-xs font-mono text-[var(--product-text-secondary)] overflow-x-auto max-h-40 overflow-y-auto">
                      <code>{JSON.stringify(executionResult.output, null, 2)}</code>
                    </pre>
                  </div>
                )}
              </form>
            </JXCardContent>
          </JXCard>
      </div>)}
      {askTargetAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--product-canvas)] p-4" role="dialog" aria-modal="true" aria-label="Ask agent">
          <form onSubmit={(event) => void handleAskAgentSubmit(event)} className="w-full max-w-xl rounded-2xl bg-[var(--product-surface)] border border-[var(--product-line)] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[var(--product-text)]">Ask {askTargetAgent.name}</h3>
              <button type="button" onClick={() => setAskTargetAgent(null)} className="text-xs text-[var(--product-text-tertiary)]">Close</button>
            </div>
            <textarea
              rows={3}
              aria-label="Ask agent prompt"
              autoComplete="off"
              value={askPrompt}
              onChange={(e) => setAskPrompt(e.target.value)}
              placeholder="Give this agent a direct instruction or question using its tools, MCP servers, and memory..."
              className="w-full rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] p-3 text-xs text-[var(--product-text)]"
            />
            {askResult && (
              <div className="rounded-xl border border-[var(--product-line)] bg-[var(--product-canvas)] p-3 space-y-2 max-h-64 overflow-y-auto text-xs">
                <p className="whitespace-pre-wrap text-[var(--product-text-secondary)]">{askResult.response}</p>
                {askResult.steps.length > 0 && (
                  <div className="border-t border-[var(--product-line)] pt-2 space-y-1 font-mono text-[11px]">
                    <span className="text-[var(--product-text-tertiary)]">Executed {askResult.steps.length} tool step(s):</span>
                    {askResult.steps.map((s: any, i: number) => (
                      <div key={i} className="text-indigo-300">{i + 1}. {s.tool} ({s.device || "local"})</div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <JXButton type="button" variant="outlined" color="neutral" size="sm" onClick={() => setAskTargetAgent(null)}>Close</JXButton>
              <JXButton type="submit" variant="contained" color="primary" size="sm" disabled={askBusy || !askPrompt.trim()}>
                {askBusy ? "Running..." : "Send to Agent"}
              </JXButton>
            </div>
          </form>
        </div>
      )}

      {memoryTargetAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--product-canvas)] p-4" role="dialog" aria-modal="true" aria-label="Edit agent memory">
          <form onSubmit={(event) => void handleSaveAgentMemory(event)} className="w-full max-w-lg rounded-2xl bg-[var(--product-surface)] border border-[var(--product-line)] p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[var(--product-text)]">Memory — {memoryTargetAgent.name}</h3>
              <button type="button" onClick={() => setMemoryTargetAgent(null)} className="text-xs text-[var(--product-text-tertiary)]">Close</button>
            </div>
            <textarea
              rows={6}
              aria-label="Agent memory"
              autoComplete="off"
              value={memoryDraft}
              onChange={(e) => setMemoryDraft(e.target.value)}
              placeholder="Pinned facts, context, or operational notes persisted across cycles..."
              className="w-full rounded-xl bg-[var(--product-canvas)] border border-[var(--product-line)] p-3 font-mono text-xs text-[var(--product-text)]"
            />
            <div className="space-y-2 border-t border-[var(--product-line)] pt-3">
              <p className="text-xs font-medium text-[var(--product-text-secondary)]">Project / task chunks</p>
              <div className="flex flex-wrap gap-2">
                <input
                  className="rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] px-2 py-1 text-xs"
                  aria-label="Filter memory chunks by project"
                  autoComplete="off"
                  placeholder="project filter"
                  value={memoryProjectFilter}
                  onChange={(e) => setMemoryProjectFilter(e.target.value)}
                />
                <input
                  className="rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] px-2 py-1 text-xs"
                  aria-label="Filter memory chunks by task"
                  autoComplete="off"
                  placeholder="task filter"
                  value={memoryTaskFilter}
                  onChange={(e) => setMemoryTaskFilter(e.target.value)}
                />
                <JXButton
                  type="button"
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  onClick={() => void loadMemoryChunks(memoryTargetAgent.id, memoryProjectFilter, memoryTaskFilter)}
                >
                  Filter
                </JXButton>
                <JXButton
                  type="button"
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  disabled={agentBusy}
                  onClick={async () => {
                    setAgentBusy(true);
                    try {
                      await api.clearAgentMemoryChunks(memoryTargetAgent.id, {
                        project: memoryProjectFilter || undefined,
                        task: memoryTaskFilter || undefined,
                      });
                      await loadMemoryChunks(memoryTargetAgent.id, memoryProjectFilter, memoryTaskFilter);
                    } catch (error) {
                      pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
                    } finally {
                      setAgentBusy(false);
                    }
                  }}
                >
                  Clear chunks
                </JXButton>
              </div>
              <ul className="max-h-40 space-y-1 overflow-auto text-xs text-[var(--product-text-tertiary)]">
                {memoryChunks.length === 0 ? (
                  <li>No chunks yet.</li>
                ) : (
                  memoryChunks.map((c, i) => (
                    <li key={`${c.chunk_index ?? i}-${i}`} className="rounded bg-[var(--product-canvas)] px-2 py-1">
                      {(c.project_tag || c.task_tag) && (
                        <span className="mr-2 text-[var(--product-text-secondary)]">
                          {[c.project_tag && `p:${c.project_tag}`, c.task_tag && `t:${c.task_tag}`].filter(Boolean).join(" ")}
                        </span>
                      )}
                      {c.content}
                    </li>
                  ))
                )}
              </ul>
              <div className="flex flex-wrap gap-2">
                <input
                  className="min-w-[12rem] flex-1 rounded-lg bg-[var(--product-canvas)] border border-[var(--product-line)] px-2 py-1 text-xs"
                  aria-label="New memory chunk fact"
                  autoComplete="off"
                  placeholder="New chunk fact"
                  value={memoryChunkDraft}
                  onChange={(e) => setMemoryChunkDraft(e.target.value)}
                />
                <JXButton
                  type="button"
                  variant="contained"
                  color="primary"
                  size="sm"
                  disabled={agentBusy || !memoryChunkDraft.trim()}
                  onClick={async () => {
                    setAgentBusy(true);
                    try {
                      await api.appendAgentMemoryChunk(memoryTargetAgent.id, {
                        content: memoryChunkDraft.trim(),
                        project: memoryProjectFilter || undefined,
                        task: memoryTaskFilter || undefined,
                      });
                      setMemoryChunkDraft("");
                      await loadMemoryChunks(memoryTargetAgent.id, memoryProjectFilter, memoryTaskFilter);
                    } catch (error) {
                      pushNotice({ tone: "error", title: "Could not update agent", message: describeError(error) });
                    } finally {
                      setAgentBusy(false);
                    }
                  }}
                >
                  Append chunk
                </JXButton>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <JXButton type="button" variant="outlined" color="neutral" size="sm" onClick={() => setMemoryTargetAgent(null)}>Cancel</JXButton>
              <JXButton type="submit" variant="contained" color="primary" size="sm" disabled={agentBusy}>
                Save Memory
              </JXButton>
            </div>
          </form>
        </div>
      )}
      {deleteMcpConfirm && (
        <ConfirmDestructive
          open
          title="Disconnect MCP service"
          objectName={deleteMcpConfirm.name}
          consequence="Agents using it will lose access to its tools. The service can be reconnected later."
          confirmLabel="Disconnect service"
          onConfirm={() => { const srv = deleteMcpConfirm; setDeleteMcpConfirm(null); void handleDeleteMcpServer(srv); }}
          onCancel={() => setDeleteMcpConfirm(null)}
        />
      )}
      {deleteAgentConfirm && (
        <ConfirmDestructive
          open
          title="Delete custom agent"
          objectName={deleteAgentConfirm.name}
          consequence="Its run history is removed too. This cannot be undone."
          confirmLabel="Delete agent"
          onConfirm={() => { const agent = deleteAgentConfirm; setDeleteAgentConfirm(null); void handleDeleteAgent(agent); }}
          onCancel={() => setDeleteAgentConfirm(null)}
        />
      )}
    </div>
  );
};

export default AiApiHubView;

