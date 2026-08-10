"use client";

import { useMemo } from "react";
import { usePolling } from "./live-hooks";

/**
 * The site background: a settlement radar.
 *
 * Concept borrowed from the Evil Martians reference — concentric rings, a rotating sweep, and
 * labelled blips — because it is not just a look, it is the right metaphor. A tripwire is a
 * detection device. So the background is a radar that is actually watching something: every
 * blip is a real job read from the deployed contracts, plotted by id and coloured by state.
 *
 * This replaces two earlier attempts that were rightly rejected: a drifting gradient cloud
 * (decoration that meant nothing) and a band of wires trapped inside the 960px content column
 * (motion confined to one strip rather than a living background).
 *
 * Fixed to the viewport so the whole page sits on a living surface, not just the hero. The
 * sweep is a single rotating conic gradient and the blips are CSS-animated — no JS ticking,
 * no canvas, no per-frame React work. Purely decorative, so aria-hidden.
 */

type Job = { id: string; status: number; sellerAtFault?: boolean; amount?: string };
type JobsResponse = { jobs: Job[] };

/** Radar sweep period. Every blip's ping is phase-locked to this so pings track the sweep. */
const SWEEP_SECONDS = 42;

function toneFor(job: Job) {
  if (job.status === 1) return "pending";
  if (job.status === 2) return "ok";
  if (job.status === 3) return "alarm";
  if (job.status === 4) return job.sellerAtFault === false ? "ok" : "alarm";
  return "neutral";
}

function labelFor(job: Job) {
  if (job.status === 1) return "ESCROWED";
  if (job.status === 2) return "RELEASED";
  if (job.status === 3) return "DISPUTED";
  if (job.status === 4) return job.sellerAtFault === false ? "CLEARED" : "SLASHED";
  return "TIMED OUT";
}

export function SiteField() {
  const { data } = usePolling<JobsResponse>("/api/live/jobs", 20_000);

  // Plot each job at a deterministic angle and radius derived from its id, so a job always
  // sits in the same place across reloads rather than jumping around on every poll.
  const blips = useMemo(() => {
    const jobs = (data?.jobs ?? []).slice(-9);
    return jobs.map((job) => {
      const n = Number(job.id) || 0;
      const angle = (n * 137.5) % 360;            // golden-angle spread, avoids clustering
      const radius = 21 + ((n * 37) % 26);        // percentage of the radar's half-extent
      const radians = (angle * Math.PI) / 180;
      return {
        job,
        tone: toneFor(job),
        label: labelFor(job),
        // Only the newest few are annotated; the rest stay as quiet blips so the field does
        // not turn into a wall of text behind the copy.
        annotated: false,
        left: 50 + Math.cos(radians) * radius,
        top: 50 + Math.sin(radians) * radius * 0.82, // slight squash: reads as perspective
        // Phase-lock the ping to the moment the sweep passes this angle.
        delay: -(SWEEP_SECONDS * (1 - angle / 360)),
      };
    }).map((blip, index, all) => ({ ...blip, annotated: index >= all.length - 4 }));
  }, [data?.jobs]);

  return (
    <div className="site-field" aria-hidden="true">
      <div className="radar">
        {/* Rings. Fixed sizes rather than generated so they read as a calibrated instrument. */}
        {[100, 74, 50, 28].map((size) => <i key={size} className="radar-ring" style={{ width: `${size}%`, height: `${size}%` }} />)}
        <i className="radar-cross radar-cross-h" />
        <i className="radar-cross radar-cross-v" />

        {/* The sweep: one rotating conic wedge with a trailing fade. */}
        <i className="radar-sweep" style={{ animationDuration: `${SWEEP_SECONDS}s` }} />

        {blips.map(({ job, tone, label, left, top, delay, annotated }) => (
          <span
            key={job.id}
            className={`radar-blip ${tone}`}
            style={{ left: `${left}%`, top: `${top}%`, animationDelay: `${delay}s`, animationDuration: `${SWEEP_SECONDS}s` }}
          >
            <i />
            {annotated && <b>JOB #{job.id}<em>{label}</em></b>}
          </span>
        ))}
      </div>
    </div>
  );
}
