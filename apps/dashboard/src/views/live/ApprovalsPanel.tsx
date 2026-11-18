import React, { useCallback, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { EmptyState, GlassModal, JXButton } from "../../ui";
import { Field, fieldClass, LiveApproval, message, Payload, ReadState, text, time, useRead } from "./shared";

export function ApprovalsPanel({ canDecide }: { canDecide: boolean }) {
  const load = useCallback(async () => {
    const result = await api.approvals();
    if (!Array.isArray(result)) throw new Error("The server returned an invalid approval list.");
    return result as LiveApproval[];
  }, []);
  const state = useRead(load, true);
  const { data, error, loading, refresh } = state;
  const [history, setHistory] = useState(false);
  const [decision, setDecision] = useState<{ approval: LiveApproval; value: "approved" | "denied" }>();
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const locked = useRef(false);
  const decide = async () => {
    if (!decision || locked.current) return;
    locked.current = true; setBusy(true); setFeedback("");
    try {
      await api.decide(decision.approval.id, decision.value, reason.trim());
      setDecided(true); setFeedback(`Decision saved: ${decision.value}.`);
    } catch (err) {
      const uncertain = err instanceof ApiError && err.uncertain;
      setFeedback(uncertain ? `${message(err)} Refresh approvals to check the decision before trying again.` : message(err));
      // A conflict or uncertain result must be reconciled, never resubmitted from this dialog.
      if (uncertain || (err instanceof ApiError && err.status === 409)) setDecided(true);
      else locked.current = false;
    } finally { setBusy(false); void refresh(); }
  };
  const approvals = (data || []).filter((approval) => history || approval.status === "pending");
  return <section aria-label="Approvals" className="space-y-5">
    <div className="rounded-lg border border-[var(--product-line)] p-3 text-xs leading-relaxed text-[var(--product-text-tertiary)]">
      <p className="font-medium text-[var(--product-text-secondary)]">Approvals gate sensitive tasks</p>
      <p>An approval releases exactly the action shown below — one tool, on one device, with the listed arguments. Denying cancels the pending task. Nothing runs until an administrator decides.</p>
      <p>Tier 1 — read-only · Tier 2 — workspace edits · Tier 3 — elevated shell · Tier 4 — kernel. Higher tiers always need a human decision.</p>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center gap-2 text-sm text-[var(--product-text-secondary)]"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />Show decision history</label>
      <JXButton color="neutral" variant="outlined" disabled={loading} onClick={refresh}>Refresh approvals</JXButton>
    </div>
    <ReadState {...state} />
    {error && <p role="alert" className="text-sm text-amber-300">{error} Previously loaded approvals may be stale.</p>}
    {loading && !data && <p role="status" className="py-6 text-sm text-[var(--product-text-tertiary)]">Loading approvals…</p>}
    {data && !approvals.length && <EmptyState variant="bare" title={history ? "No approval requests" : "No pending approvals"} description="Requests needing human review will appear here." />}
    {!canDecide && <p className="text-xs text-[var(--product-text-tertiary)]">An administrator with current fleet data is required to decide approvals.</p>}
    <ul className="divide-y divide-[var(--product-line)]">{approvals.map((approval) => <li key={approval.id} className="space-y-4 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h3 className="break-all text-sm font-medium">{approval.tool || "Unknown action"} · {approval.device_name || approval.device_id || "Device not recorded"}</h3>
          <p className="mt-1 text-xs text-[var(--product-text-tertiary)]">{approval.status}{approval.tier != null ? ` · Tier ${approval.tier}` : ""} · {time(approval.created_at)}</p></div>
        {approval.status === "pending" && <div className="flex gap-2">{(["denied", "approved"] as const).map((value) => <JXButton key={value} color={value === "approved" ? "primary" : "neutral"} variant="outlined"
          disabled={!canDecide || !!error} onClick={() => { locked.current = false; setDecision({ approval, value }); setReason(""); setFeedback(""); setDecided(false); }}>{value === "approved" ? "Review approval" : "Deny"}</JXButton>)}</div>}
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-[var(--product-text-tertiary)]">Requested by</dt><dd className="break-all">{approval.requested_by || "Not recorded by the server"}</dd></div>
        <div><dt className="text-[var(--product-text-tertiary)]">Reason for review</dt><dd>{approval.reason || "Not provided"}</dd></div>
      </dl>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--product-canvas)] p-3 text-xs">{text(approval.args || {})}</pre>
      <Payload value={{ approval_id: approval.id, task_id: approval.task_id, device_id: approval.device_id, tier: approval.tier }} />
    </li>)}</ul>
    {decision && <GlassModal title={decision.value === "approved" ? "Approve this exact action?" : "Deny this action?"} onClose={() => { if (!busy) setDecision(undefined); }}>
      <div className="space-y-4">
        <p className="break-all text-sm">{decision.approval.tool} on {decision.approval.device_name || decision.approval.device_id} ({decision.approval.device_id}){decision.approval.tier != null ? ` · Tier ${decision.approval.tier}` : ""}</p>
        <p className="text-sm text-amber-300">{decision.value === "approved" ? "Approval releases this task for execution under the device policy." : "Denial cancels the pending task."}</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--product-canvas)] p-3 text-xs">{text(decision.approval.args || {})}</pre>
        <Field label="Decision reason (optional)"><textarea disabled={busy || decided} className={fieldClass} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} /></Field>
        {feedback && <p role="status" className="text-sm text-[var(--product-text-secondary)]">{feedback}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <JXButton color="neutral" variant="outlined" disabled={busy} onClick={() => setDecision(undefined)}>{decided ? "Done" : "Cancel"}</JXButton>
          {!decided && <JXButton disabled={busy || !canDecide || !!error} loading={busy} onClick={decide}>{decision.value === "approved" ? "Confirm approval" : "Confirm denial"}</JXButton>}
        </div>
      </div>
    </GlassModal>}
  </section>;
}
