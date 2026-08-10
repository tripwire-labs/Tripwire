"use client";

/**
 * The hero background: a field of tripwires.
 *
 * Not decoration. The product's whole claim is that a payment travels toward a seller and is
 * held until it is verified — and that a failed delivery trips a wire and sends the money
 * back. So the background performs that: taut wires span the viewport, payment pulses travel
 * along them, most complete cleanly, and periodically one trips — flashing alarm and
 * recoiling back the way it came.
 *
 * A drifting cloud of colour was the first attempt and it was rejected for being exactly the
 * kind of generic gradient decoration that means nothing. This says something.
 *
 * Implementation is pure SVG + CSS animation — no JS ticking, no canvas, no per-frame work in
 * React. Each pulse is a short bright dash animated along its wire via stroke-dashoffset,
 * which the compositor handles cheaply. Entirely decorative, so aria-hidden.
 */

/** One wire: vertical position (%), how long a pulse takes to cross, and its start offset. */
type Wire = { y: number; duration: number; delay: number; trips: boolean };

const WIRES: Wire[] = [
  { y: 12, duration: 7.5, delay: 0, trips: false },
  { y: 23, duration: 9.5, delay: -3.2, trips: false },
  { y: 34, duration: 6.5, delay: -1.4, trips: true },
  { y: 45, duration: 11, delay: -6, trips: false },
  { y: 56, duration: 8, delay: -2.1, trips: false },
  { y: 67, duration: 10, delay: -4.8, trips: true },
  { y: 78, duration: 7, delay: -0.7, trips: false },
  { y: 89, duration: 12, delay: -5.5, trips: false },
];

export function HeroField() {
  return (
    <div className="hero-field" aria-hidden="true">
      <svg viewBox="0 0 1000 600" preserveAspectRatio="none">
        <defs>
          {/* Fades the wires out at the edges so they read as a field rather than as ruled lines. */}
          <linearGradient id="wire-fade" x1="0" x2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.22" stopColor="#fff" stopOpacity="0.5" />
            <stop offset="0.78" stopColor="#fff" stopOpacity="0.5" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="wire-mask">
            <rect width="1000" height="600" fill="url(#wire-fade)" />
          </mask>
        </defs>

        <g mask="url(#wire-mask)">
          {WIRES.map((wire) => {
            const y = (wire.y / 100) * 600;
            const style = { "--dur": `${wire.duration}s`, "--delay": `${wire.delay}s` } as React.CSSProperties;
            return (
              <g key={wire.y} className={`wire ${wire.trips ? "wire-trip" : ""}`} style={style}>
                {/* The taut wire itself — always present, barely visible. */}
                <line className="wire-base" x1="0" y1={y} x2="1000" y2={y} />
                {/* The payment travelling along it. */}
                <line className="wire-pulse" x1="0" y1={y} x2="1000" y2={y} />
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
