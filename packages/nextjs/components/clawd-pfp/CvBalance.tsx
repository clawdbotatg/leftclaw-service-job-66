"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";

export const CvBalance = () => {
  const { address } = useAccount();
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/cv-balance?address=${address}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { balance?: number };
        if (!cancelled && typeof data.balance === "number") setBalance(data.balance);
      } catch {
        // best-effort — no-op on network errors
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [address]);

  if (!address || balance === null) return null;

  return (
    <div
      className="hidden sm:flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-md bg-secondary text-secondary-content"
      title="Your CV balance on larv.ai"
    >
      <span>{balance.toLocaleString()}</span>
      <span className="opacity-60">CV</span>
    </div>
  );
};
