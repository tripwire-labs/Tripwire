"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function middle(value: string, start = 6, end = 4) {
  return value.length <= start + end + 1 ? value : `${value.slice(0, start)}…${value.slice(-end)}`;
}

export function CopyValue({ value, label, compact = true }: { value: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <button className="copy-value" type="button" onClick={copy} title={value} aria-label={`Copy ${label ?? value}`}>
      <span>{compact ? middle(value) : value}</span>{copied ? <Check size={13} /> : <Copy size={13} />}
      <span className="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span>
    </button>
  );
}

