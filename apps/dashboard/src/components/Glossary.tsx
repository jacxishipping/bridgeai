/**
 * Glossary (UX-25). One-sentence definitions for the core jargon used
 * across the dashboard, written in plain language. Shown in a modal from
 * the sidebar footer and from the task-studio tier legend; it is a modal,
 * not a route, so the 15-destination nav table (and its tests) stay intact.
 */
import React from "react";
import { GlassModal } from "../ui";

export const GLOSSARY_TERMS: { term: string; definition: string }[] = [
  { term: "Tier", definition: "A risk level for a tool call: Tier 1 is read-only, Tier 2 edits the workspace, Tier 3 runs an elevated shell, Tier 4 reaches the kernel." },
  { term: "Policy", definition: "A set of rules the control plane enforces before a tool runs, such as which tiers need human approval." },
  { term: "Approval", definition: "A human decision that allows or denies a task the policy flagged for review." },
  { term: "Device", definition: "An enrolled computer the control plane can run tasks on." },
  { term: "Host", definition: "The computer running the control-plane process itself — not an enrolled device." },
  { term: "Node", definition: "Not used as a product term; an enrolled computer is called a device." },
  { term: "Client", definition: "An OAuth or MCP client application connecting to the control plane — not an enrolled device." },
  { term: "Task", definition: "One tool invocation on one device." },
  { term: "Workflow", definition: "A multi-step sequence of tasks that runs in order." },
  { term: "Schedule", definition: "A timed trigger that creates tasks on a schedule." },
  { term: "MCP", definition: "Model Context Protocol: the open protocol AI assistants use to call tools on the control plane." },
  { term: "OAuth", definition: "The sign-in standard the control plane uses to issue tokens, so clients never need the admin password." },
  { term: "JWT", definition: "A signed token that carries who the caller is and what it may do." },
  { term: "SSE", definition: "Server-Sent Events: the one-way stream the control plane uses to push live updates to the dashboard." },
  { term: "Merkle", definition: "A hash-chained ledger: each audit record links to the one before it, so tampering breaks the chain." },
  { term: "mTLS", definition: "Mutual TLS: both sides of a connection prove their identity with certificates." },
  { term: "SoM (Set-of-Marks)", definition: "Numbered boxes drawn over a desktop screenshot so an agent can point at a control by number." },
  { term: "WASAPI", definition: "The Windows audio system; desktop audio capture through it is not shipped in this build." },
  { term: "Opus", definition: "An audio codec, named in older copy for the desktop audio path that is not shipped in this build." },
];

export function GlossaryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <GlassModal open={open} onClose={onClose} title="Glossary">
      <div className="space-y-3">
        <p className="text-xs text-[var(--product-text-tertiary)]">
          Plain-language definitions for the terms used across the dashboard.
        </p>
        <dl className="space-y-2.5">
          {GLOSSARY_TERMS.map(({ term, definition }) => (
            <div key={term} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="shrink-0 font-mono text-xs font-semibold text-[var(--product-text)] sm:w-40">
                {term}
              </dt>
              <dd className="text-xs leading-relaxed text-[var(--product-text-secondary)]">{definition}</dd>
            </div>
          ))}
        </dl>
      </div>
    </GlassModal>
  );
}
