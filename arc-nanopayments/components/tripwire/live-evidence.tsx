"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { CopyValue, middle } from "./copy-value";
import { useFreshness, usePolling } from "./live-hooks";
import { SettlementMatrix } from "./settlement-matrix";
import { CountUp } from "./motion";

type State = { jobsSettled:number; totalJobs:number; escrowed:string; bond:{gross:string;reserved:string;free:string}; bondRatio:number; responseWindowSeconds:number; registryEnabled:boolean; updatedAt:string; identities:{jobEscrow:string;sellerBond:string;arbiter:string;primarySellerAgentId:string} };
type Job = { id:string;endpoint:string|null;amount:string;reservedBond:string;buyer:string;status:number;statusLabel?:string;sellerAtFault?:boolean;responseDeadline:number;completionDeadline:number;validationRequestHash:string;evidenceHash:string;deliveredAt:string|null;proofs:Record<string,string> };
type Jobs = { jobs:Job[];total:number;updatedAt:string };

function statusMeta(job: Job) {
  if (job.status === 1) return ["pending", "Escrowed"];
  if (job.status === 2) return ["ok", "Released"];
  if (job.status === 3) return ["alarm", "Disputed"];
  if (job.status === 4) return job.sellerAtFault === true ? ["alarm", "Slashed"] : job.sellerAtFault === false ? ["ok", "Seller cleared"] : ["neutral", "Resolved"];
  if (job.status === 5) return ["neutral", "Timed out"];
  return ["neutral", "Unknown"];
}

function relative(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.floor(now / 1000 - timestamp));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function EvidenceZone({ yours }: { yours: string[] }) {
  const state = usePolling<State>("/api/live/state");
  const jobs = usePolling<Jobs>("/api/live/jobs");
  const fresh = useFreshness(state.data?.updatedAt);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const initial = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearTimeout(initial); clearInterval(timer); };
  }, []);
  function selectJob(id: string) { setExpanded(id); document.getElementById(`job-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }
  // Numeric tiles animate to their new value on each poll — a figure that ticks reads as
  // live, a figure that jumps reads as a re-render. Non-numeric tiles (ratio, window,
  // registry state) stay static because they almost never change and counting them would be
  // motion for its own sake.
  const tiles = state.data ? [
    { label: "Jobs settled", value: <CountUp value={state.data.jobsSettled} decimals={0}/> },
    { label: "USDC in escrow", value: <><CountUp value={state.data.escrowed}/> USDC</> },
    { label: "Seller bond posted", value: <><CountUp value={state.data.bond.gross}/> USDC</> },
    { label: "Reserved / free", value: <><CountUp value={state.data.bond.reserved}/> / <CountUp value={state.data.bond.free}/></> },
    { label: "Bond ratio", value: `${state.data.bondRatio}%` },
    { label: "Response window", value: `${state.data.responseWindowSeconds / 3600}h` },
    { label: "Registry", value: state.data.registryEnabled ? "● ENFORCING" : "● BYPASSED" },
  ] : [];

  return <section className="evidence-section shell-wide" id="evidence">
    <div className="evidence-heading"><div><p className="micro-label">Evidence / Live instrumentation</p><h2>Corroborate every step.</h2></div><span className={state.stale ? "freshness stale" : "freshness"}>{state.stale ? "stale · " : "updated "}{fresh}</span></div>
    {state.loading && !state.data ? <div className="stat-scroll">{Array.from({ length: 7 }, (_, i) => <div className="stat-tile skeleton-card" key={i}/>)}</div> : state.error && !state.data ? <div className="error-panel"><p>Arc state could not be read. No financial value has been replaced with zero.</p><button onClick={state.retry} className="pill pill-secondary">Retry</button></div> : <div className="stat-scroll">{tiles.map(tile => <div className="stat-tile" key={tile.label}><span className="micro-label">{tile.label}</span><b>{tile.value}</b></div>)}</div>}
    {state.data && <div className="identity-strip"><span>JobEscrow <CopyValue value={state.data.identities.jobEscrow}/></span><span>SellerBond <CopyValue value={state.data.identities.sellerBond}/></span><span>Arbiter <CopyValue value={state.data.identities.arbiter}/></span><span>Seller agent <CopyValue value={state.data.identities.primarySellerAgentId} compact={false}/></span></div>}
    <div className="evidence-block"><div className="block-head"><div><p className="micro-label">Settlement matrix</p><p>One glyph per permanent on-chain job. Colour is state; idle cells are unused capacity.</p></div></div><SettlementMatrix jobs={jobs.data?.jobs} onSelect={selectJob}/></div>
    <div className="evidence-block job-stream"><div className="block-head"><div><p className="micro-label">Job stream · all history</p><p>Read from <code>nextJobId()</code> + multicall, never expiring event logs.</p></div><span>{jobs.data?.total ?? "—"} jobs</span></div>
      {jobs.loading && !jobs.data ? <div className="table-skeleton">Loading permanent job history…</div> : jobs.error && !jobs.data ? <div className="error-panel"><p>The chain job list is unavailable. Last-good rows are never replaced with zeroes.</p><button onClick={jobs.retry}>Retry</button></div> : !jobs.data?.jobs.length ? <div className="empty-panel"><h3>No jobs yet</h3><p>A job is buyer USDC held in escrow with seller bond reserved against it. Choose a seller in Act I to create the first one.</p></div> : <div className="jobs-table" role="table" aria-live="polite"><div className="jobs-header" role="row"><span>Job</span><span>Endpoint</span><span>Amount</span><span>Bond</span><span>Buyer</span><span>Status</span><span>Age</span><span>Proof</span></div>{jobs.data.jobs.map(job => <JobRow key={job.id} job={job} now={now} yours={yours.includes(job.id)} expanded={expanded === job.id} onToggle={() => setExpanded(expanded === job.id ? null : job.id)}/>)}</div>}
    </div>
  </section>;
}

function JobRow({ job, now, yours, expanded, onToggle }: { job:Job;now:number;yours:boolean;expanded:boolean;onToggle:()=>void }) {
  const [tone, label] = statusMeta(job);
  const remaining = Math.max(0, job.responseDeadline - Math.floor(now / 1000));
  return <div className={`job-record ${expanded ? "expanded" : ""}`} id={`job-${job.id}`}>
    <button className="job-row" role="row" onClick={onToggle} aria-expanded={expanded}><span><b>#{job.id}</b>{yours && <em>Yours</em>}</span><span>{job.endpoint ?? "—"}</span><span>{job.amount} USDC</span><span>{job.reservedBond}</span><span title={job.buyer}>{middle(job.buyer)}</span><span><i className={`status-chip ${tone}`}>● {label}</i></span><span title={new Date(job.completionDeadline * 1000).toUTCString()}>{relative(job.completionDeadline, now)} ago</span><span><ExternalLink size={13}/><ChevronDown size={13}/></span></button>
    {expanded && <div className="job-detail"><div><span className="micro-label">Lifecycle · Job id</span><CopyValue value={job.id} compact={false}/><ol><li className="done">Job #{job.id} created · principal and bond locked {job.proofs.create && <TxLink hash={job.proofs.create}/>}</li>{job.deliveredAt && <li className="done">Delivered {new Date(job.deliveredAt).toLocaleString()}</li>}<li className={job.status > 1 ? "done" : "active"}>{label}{job.status === 1 ? ` · ${Math.floor(remaining / 3600)}h ${Math.floor(remaining % 3600 / 60)}m ${remaining % 60}s to respond` : ""} {(job.proofs.release || job.proofs.dispute || job.proofs.resolve || job.proofs.timeout) && <TxLink hash={job.proofs.resolve ?? job.proofs.release ?? job.proofs.dispute ?? job.proofs.timeout}/>}</li></ol></div><div><span className="micro-label">Validation request</span><CopyValue value={job.validationRequestHash}/>{job.status >= 3 && <><span className="micro-label evidence-label">Evidence hash</span><CopyValue value={job.evidenceHash}/></>}</div><a href={`https://testnet.arcscan.app/address/${job.buyer}`} target="_blank" rel="noopener noreferrer">Open buyer on Arcscan <ExternalLink size={12}/></a></div>}
  </div>;
}

function TxLink({ hash }: { hash: string }) {
  return <a className="tx-inline" href={`https://testnet.arcscan.app/tx/${hash}`} target="_blank" rel="noopener noreferrer" title={hash}>tx <ExternalLink size={10}/></a>;
}
