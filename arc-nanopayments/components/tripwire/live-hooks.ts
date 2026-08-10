"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function usePolling<T>(url: string, interval = 12_000) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastGood = useRef<T | null>(null);
  const fetchNow = useCallback(async () => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const next = await response.json() as T;
      lastGood.current = next;
      setData(next);
      setError(null);
    } catch (err) {
      setData(lastGood.current);
      setError(err instanceof Error ? err.message : "Live data unavailable");
    } finally { setLoading(false); }
  }, [url]);
  useEffect(() => {
    fetchNow();
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!document.hidden) timer = setInterval(fetchNow, interval);
    };
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => { if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, [fetchNow, interval]);
  return { data, loading, error, retry: fetchNow, stale: Boolean(error && data) };
}

export function useFreshness(iso?: string) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const update = () => setSeconds(iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000)) : 0);
    update(); const timer = setInterval(update, 1_000); return () => clearInterval(timer);
  }, [iso]);
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

