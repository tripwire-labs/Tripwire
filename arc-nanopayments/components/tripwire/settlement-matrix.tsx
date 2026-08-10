"use client";

import { useEffect, useMemo, useState } from "react";
import { usePolling } from "./live-hooks";
import { useNewlyAdded } from "./motion";

export type MatrixJob = { id: string; status: number; sellerAtFault?: boolean; amount?: string };
type JobsResponse = { jobs: MatrixJob[]; updatedAt: string };

function statusClass(job: MatrixJob) {
  if (job.status === 1) return "pending";
  if (job.status === 2) return "ok";
  if (job.status === 3) return "alarm";
  if (job.status === 4) return job.sellerAtFault === false ? "ok" : "alarm";
  if (job.status === 5) return "neutral";
  return "idle";
}

export function SettlementMatrix({ jobs: supplied, compact = false, dense = false, onSelect }: { jobs?: MatrixJob[]; compact?: boolean; dense?: boolean; onSelect?: (id: string) => void }) {
  const polled = usePolling<JobsResponse>("/api/live/jobs");
  const jobs = useMemo(() => supplied ?? polled.data?.jobs ?? [], [supplied, polled.data?.jobs]);
  const cells = useMemo(() => {
    const live = [...jobs].reverse().slice(-48);
    // Pad to a canvas that stays proportionate to how much real data exists. A fixed large
    // grid made the field read as an empty box early on — with 7 jobs against 105 idle cells
    // the real settlements were lost. Scaling the padding with the job count keeps the field
    // looking like a canvas filling up rather than a broken chart, while still leaving
    // visible headroom so growth is legible.
    const minimum = dense ? 150 : compact ? 36 : 56;
    const total = Math.max(minimum, Math.ceil((live.length * 2.2) / 14) * 14);
    return [...live.map((job) => ({ job, key: `job-${job.id}` })), ...Array.from({ length: Math.max(0, total - live.length) }, (_, index) => ({ job: undefined, key: `idle-${index}` }))];
  }, [jobs, compact, dense]);
  // Pulse a glyph exactly once, when its job first appears — this is the page reacting to
  // the chain rather than to a re-render.
  const fresh = useNewlyAdded(useMemo(() => jobs.map((job) => job.id), [jobs]));
  const [active, setActive] = useState(true);
  useEffect(() => {
    const sync = () => setActive(!document.hidden);
    document.addEventListener("visibilitychange", sync); sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return (
    <div className={`settlement-matrix ${compact ? "compact" : ""} ${active ? "is-animating" : "is-paused"}`} aria-label={`${jobs.length} on-chain settlement jobs`}>
      {cells.map(({ job, key }, index) => job ? (
        <button key={key} className={`matrix-glyph ${statusClass(job)}${fresh.has(job.id) ? " is-new" : ""}`} style={{ "--delay": `${-(index % 17)}s`, "--duration": `${10 + (index % 9)}s` } as React.CSSProperties} title={`Job ${job.id} · ${job.amount ?? "—"} USDC`} onClick={() => onSelect?.(job.id)} aria-label={`Job ${job.id}`}><span>+</span></button>
      ) : <i key={key} className="matrix-glyph idle" style={{ "--delay": `${-(index % 19)}s`, "--duration": `${12 + (index % 8)}s` } as React.CSSProperties}>·</i>)}
    </div>
  );
}
