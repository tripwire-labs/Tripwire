"use client";

import Link from "next/link";
import { usePolling } from "./live-hooks";
import { CopyValue } from "./copy-value";

type State = { bond: { free: string }; identities: { jobEscrow: string; sellerBond: string }; updatedAt: string };

export function Footer() {
  const { data, loading, error } = usePolling<State>("/api/live/state");
  const healthy = Boolean(data && Number(data.bond.free) > 0 && !error);
  return (
    <footer className="site-footer">
      <div className="footer-grid shell">
        <div><div className="wordmark"><span aria-hidden="true">＋</span> tripwire</div><p>Settlement waits for proof.</p><span className={`health-chip ${healthy ? "healthy" : ""}`}><i />{loading ? "Checking systems" : healthy ? "All systems normal" : error ? "Live check stale" : "Bond unavailable"}</span></div>
        <div><p className="micro-label">Product</p><Link href="/live">Live session</Link><Link href="/#mechanism">Mechanism</Link><Link href="/live#adopt">Adopt</Link></div>
        <div><p className="micro-label">Protocol</p><a href="https://testnet.arcscan.app" target="_blank" rel="noopener noreferrer">Arcscan</a><a href="https://www.erc8004.org" target="_blank" rel="noopener noreferrer">ERC-8004</a><a href="https://www.x402.org" target="_blank" rel="noopener noreferrer">x402</a></div>
        <div><p className="micro-label">Contracts</p>{data ? <><CopyValue value={data.identities.jobEscrow} label="JobEscrow address"/><CopyValue value={data.identities.sellerBond} label="SellerBond address"/></> : <span className="muted">—</span>}</div>
      </div>
      <div className="footer-bottom shell">Dispute resolution is a single arbiter for this hackathon build — centralised, and labelled as such.</div>
    </footer>
  );
}
