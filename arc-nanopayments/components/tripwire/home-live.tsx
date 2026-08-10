"use client";

import { usePolling } from "./live-hooks";

type State = { bond: { gross: string; reserved: string; free: string }; bondRatio: number; updatedAt: string };

export function LifecycleCards() {
  const { data, loading, error, retry } = usePolling<State>("/api/live/state");
  return (
    <div className="lifecycle-grid blueprint-grid">
      <article><span className="card-index">01</span><div className="mini-instrument"><div className="bond-label"><span>GROSS {data?.bond.gross ?? "—"}</span><span>FREE {data?.bond.free ?? "—"}</span></div><div className="bond-bar"><i style={{ width: data ? `${Math.min(100, Number(data.bond.reserved) / Math.max(Number(data.bond.gross), .000001) * 100)}%` : "0%" }}/></div>{loading && <div className="skeleton-line"/>}</div><h3>Bond posted</h3><p>A seller stakes USDC against their ERC-8004 agent id before they can take work.</p></article>
      <article><span className="card-index">02</span><div className="convergence"><div><span>ERC-8004 ✓</span><span>BUYER ✓</span><span>DEADLINE ✓</span><span>HASH ✓</span></div><i/><b>ESCROW</b></div><h3>Job escrowed</h3><p>The buyer&apos;s payment enters escrow, and {data?.bondRatio ?? 20}% is locked out of the seller&apos;s bond.</p></article>
      <article><span className="card-index">03</span><div className="branch-diagram"><span className="ok-text">RELEASED</span><span>TIMED OUT</span><span className="alarm-text">SLASHED</span></div><h3>Settled</h3><p>Money moves only on a verified outcome—and a failed seller&apos;s bond covers the buyer.</p>{error && <button className="inline-retry" onClick={retry}>Live read stale · retry</button>}</article>
    </div>
  );
}
