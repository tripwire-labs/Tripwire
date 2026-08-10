"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

export function Nav({ escrowAddress }: { escrowAddress: string }) {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={`site-nav ${scrolled ? "is-scrolled" : ""}`}>
      <nav className="nav-inner" aria-label="Primary navigation">
        <Link className="wordmark" href="/" aria-label="Tripwire home"><span aria-hidden="true">＋</span> tripwire</Link>
        <div className="nav-links">
          <Link aria-current={pathname === "/" ? "page" : undefined} href="/">Home</Link>
          <Link aria-current={pathname === "/live" ? "page" : undefined} href="/live">Live</Link>
          <a href="https://github.com" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
        {pathname === "/live" ? (
          <a className="pill pill-primary nav-cta" href={`https://testnet.arcscan.app/address/${escrowAddress}`} target="_blank" rel="noopener noreferrer">View contracts <ExternalLink size={13} /></a>
        ) : <Link className="pill pill-primary nav-cta" href="/live">Watch it live</Link>}
      </nav>
    </header>
  );
}
