"use client";

import { usePolling } from "./live-hooks";

type State = { bond: { gross: string; reserved: string; free: string }; bondRatio: number; updatedAt: string };

export function LifecycleCards() {
  const { data, loading, error, retry } = usePolling<State>("/api/live/state");
  return (
    <div className="lifecycle-grid blueprint-grid">
      <article><span className="card-index">01</span><div className="mini-instrument"><div className="bond-label"><span>GROSS {data?.bond.gross ?? "—"}</span><span>FREE {data?.bond.free ?? "—"}</span></div><div className="bond-bar"><i style={{ width: data ? `${Math.min(100, Number(data.bond.reserved) / Math.max(Number(data.bond.gross), .000001) * 100)}%` : "0%" }}/></div>{loading && <div className="skeleton-line"/>}</div><h3>Seller puts money down</h3><p>Before a seller can take any job, they lock up their own USDC as a deposit.</p></article>
      <article><span className="card-index">02</span><div className="convergence"><div><span>ERC-8004 ✓</span><span>BUYER ✓</span><span>DEADLINE ✓</span><span>HASH ✓</span></div><i/><b>ESCROW</b></div><h3>Your payment is held</h3><p>Your money goes into the contract instead of to the seller — and {data?.bondRatio ?? 20}% of their deposit gets locked too.</p></article>
      <article><span className="card-index">03</span><div className="branch-diagram"><span className="ok-text">RELEASED</span><span>TIMED OUT</span><span className="alarm-text">SLASHED</span></div><h3>Good work gets paid</h3><p>If the job is done, they get the money. If it isn&apos;t, you get yours back plus their deposit.</p>{error && <button className="inline-retry" onClick={retry}>Live read stale · retry</button>}</article>
    </div>
  );
}
