"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Motion primitives for the "data-driven" layer.
 *
 * The matrix drift and act transitions cover ambient and responsive motion. This file covers
 * the third layer — things that move *because the chain moved*. That is the only kind of
 * liveness a static reference site cannot fake, and it is what separates a page that is
 * connected to something real from a screenshot of one.
 */

/** True when the visitor has asked for reduced motion. Re-evaluated on change. */
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/**
 * Animates a numeric readout to its new value instead of snapping to it.
 *
 * A number that ticks is read as live; a number that jumps is read as a re-render. Every USDC
 * figure on this page comes from a poll, so without this the whole console looks static
 * between refreshes even while the underlying values are changing.
 *
 * Deliberately does NOT animate on first paint — only on subsequent changes. Counting up from
 * zero on load would be decoration, and worse, it would imply movement that did not happen.
 */
export function CountUp({ value, decimals = 6, duration = 600, className }: { value: string | number; decimals?: number; duration?: number; className?: string }) {
  const target = typeof value === "number" ? value : Number.parseFloat(value);
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(target);
  const previous = useRef(target);
  const frame = useRef<number>(undefined);

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const from = previous.current;
    previous.current = target;
    // Nothing changed, or the visitor opted out: settle on the final value without animating.
    // Deferred into a frame rather than set synchronously here — setting state directly in an
    // effect body triggers a cascading render.
    if (from === target || reduced) {
      frame.current = requestAnimationFrame(() => setDisplay(target));
      return () => { if (frame.current) cancelAnimationFrame(frame.current); };
    }

    const started = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      // easeOutCubic — fast start, settles gently, matching the responsive-motion curve.
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (target - from) * eased);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => { if (frame.current) cancelAnimationFrame(frame.current); };
  }, [target, duration, reduced]);

  if (!Number.isFinite(target)) return <span className={className}>{String(value)}</span>;
  return <span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>{display.toFixed(decimals)}</span>;
}

/**
 * Fades a section in the first time it enters the viewport.
 *
 * Uses IntersectionObserver rather than a scroll listener so it costs nothing while idle, and
 * unobserves after firing so a section never re-animates on the way back up — re-triggering
 * reveals turns a calm page into a flickering one.
 */
export function Reveal({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    // Reduced motion is handled by deriving `visible` below rather than by setting state
    // here — same cascading-render rule as CountUp.
    if (reduced) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setShown(true); observer.unobserve(entry.target); }
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduced]);

  // Reduced-motion visitors skip the observer entirely and render fully shown.
  const visible = shown || reduced;
  return (
    <div ref={ref} className={`reveal ${visible ? "is-shown" : ""} ${className ?? ""}`} style={{ transitionDelay: visible && shown ? `${delay}ms` : "0ms" }}>
      {children}
    </div>
  );
}

/**
 * Reports which ids are newly present since the previous render pass.
 *
 * The settlement matrix uses this to pulse a glyph exactly once when its job first appears,
 * rather than re-animating the whole field on every 12s poll. Seeding from the first payload
 * matters: without it every existing job would "arrive" on page load and the field would
 * flash, announcing events that did not just happen.
 */
export function useNewlyAdded(ids: string[]) {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (seen.current === null) { seen.current = new Set(ids); return; }
    const added = ids.filter((id) => !seen.current!.has(id));
    if (added.length === 0) return;
    added.forEach((id) => seen.current!.add(id));
    setFresh(new Set(added));
    // Clear the marker after the pulse so the class does not linger on the element.
    const timer = setTimeout(() => setFresh(new Set()), 2_400);
    return () => clearTimeout(timer);
  }, [ids]);

  return fresh;
}
