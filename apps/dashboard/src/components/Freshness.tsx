import React from "react";
import { ProductStatusDot } from "../ui";
import { useLanguage, type Message } from "../i18n";

/**
 * Compact data freshness line for tables and telemetry headers.
 * Relative times use Intl.RelativeTimeFormat in the app locale (UX-29);
 * "Updated" / "Stale" / "Refreshing…" / "Not loaded" go through t().
 * The `label` prop is translated when it is a catalog message
 * ("Updated"); any other label (e.g. "Live snapshot") passes through
 * unchanged via translate()'s English fallback.
 */
export const Freshness: React.FC<{
  checkedAt?: Date | number | null;
  loading?: boolean;
  staleAfterMs?: number;
  label?: string;
}> = ({ checkedAt, loading, staleAfterMs = 60_000, label = "Updated" }) => {
  const { locale, t, date } = useLanguage();
  if (loading) {
    return (
      <span role="status" className="inline-flex items-center gap-2 text-xs text-[var(--product-text-tertiary)]">
        <ProductStatusDot status="idle" pulse={false} />
        {t("Refreshing…")}
      </span>
    );
  }
  if (!checkedAt) {
    return (
      <span role="status" className="inline-flex items-center gap-2 text-xs text-[var(--product-text-tertiary)]">
        <ProductStatusDot status="offline" pulse={false} />
        {t("Not loaded")}
      </span>
    );
  }
  const ts = typeof checkedAt === "number" ? checkedAt * (checkedAt < 1e12 ? 1000 : 1) : checkedAt.getTime();
  const age = Date.now() - ts;
  const stale = age > staleAfterMs;
  const absolute = date(new Date(ts));
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const relative =
    age < 5_000 ? rtf.format(0, "second") :
    age < 60_000 ? rtf.format(-Math.floor(age / 1000), "second") :
    age < 3_600_000 ? rtf.format(-Math.floor(age / 60_000), "minute") :
    rtf.format(-Math.floor(age / 3_600_000), "hour");
  return (
    <span
      role="status"
      title={absolute}
      className={`inline-flex items-center gap-2 text-xs tabular-nums ${stale ? "text-amber-300" : "text-[var(--product-text-tertiary)]"}`}
    >
      <ProductStatusDot status={stale ? "warn" : "online"} pulse={!stale} />
      {stale ? `${t("Stale")} · ` : ""}{t(label as Message)} {relative}
    </span>
  );
};
