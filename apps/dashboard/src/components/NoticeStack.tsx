/**
 * Global notice stack (UX-06). Renders every notice pushed via
 * src/state/notices.ts as a dismissible card, fixed bottom-right.
 *
 * - success / info auto-dismiss after 5 s; warning / error persist
 *   until dismissed (policy lives here, in one place).
 * - success / info use role="status"; warning / error use role="alert".
 * - Mounted once at the App level (src/App.tsx); do NOT mount it again
 *   in individual views.
 */
import React, { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { dismissNotice, useNotices, type Notice, type NoticeTone } from "../state/notices";

/** Auto-dismiss delay for success/info notices (UX-06 policy: 5 s). */
export const NOTICE_AUTO_DISMISS_MS = 5000;

const toneStyles: Record<NoticeTone, { card: string; icon: string; Icon: typeof CheckCircle2 }> = {
  success: {
    card: "border-emerald-500/40 bg-emerald-950/90 text-emerald-100",
    icon: "text-emerald-400",
    Icon: CheckCircle2,
  },
  error: {
    card: "border-rose-500/40 bg-rose-950/90 text-rose-100",
    icon: "text-rose-400",
    Icon: XCircle,
  },
  info: {
    card: "border-indigo-500/40 bg-indigo-950/90 text-indigo-100",
    icon: "text-indigo-300",
    Icon: Info,
  },
  warning: {
    card: "border-amber-500/40 bg-amber-950/90 text-amber-100",
    icon: "text-amber-400",
    Icon: AlertTriangle,
  },
};

function NoticeCard({ notice }: { notice: Notice }) {
  const { card, icon, Icon } = toneStyles[notice.tone];
  const autoDismiss = notice.tone === "success" || notice.tone === "info";
  useEffect(() => {
    if (!autoDismiss) return;
    const timer = setTimeout(() => dismissNotice(notice.id), NOTICE_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [autoDismiss, notice.id]);
  return (
    <div
      role={notice.tone === "error" || notice.tone === "warning" ? "alert" : "status"}
      className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-3 py-2.5 text-xs shadow-2xl backdrop-blur ${card}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold leading-snug">{notice.title}</p>
        {notice.message && <p className="mt-0.5 leading-relaxed opacity-90">{notice.message}</p>}
        {notice.actionLabel && notice.actionHref && (
          <a href={notice.actionHref} className="mt-1 inline-block font-semibold underline underline-offset-2 hover:opacity-80">
            {notice.actionLabel}
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismissNotice(notice.id)}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-md p-1 opacity-70 hover:bg-white/10 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export function NoticeStack() {
  const notices = useNotices();
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      {notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
    </div>
  );
}
