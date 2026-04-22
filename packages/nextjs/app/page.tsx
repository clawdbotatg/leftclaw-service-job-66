"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { CountdownTimer } from "~~/components/clawd-pfp/CountdownTimer";
import { PFPCard } from "~~/components/clawd-pfp/PFPCard";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";

const OPENSEA_COLLECTION_URL = "https://opensea.io/assets/ethereum/0xb5741b033c45330a34952436a34b1b25a208af10";

// Bump this suffix when the PFP list shape changes so old caches get dropped
// instead of quietly shadowing new fields.
const GALLERY_CACHE_KEY = "clawdGallery:v1";

type PfpEntry = {
  id: number;
  image: string | null;
  minter: string;
  tokenUri: string;
  name: string | null;
  description: string | null;
};

const Home: NextPage = () => {
  const { data: mintDeadline, isLoading: isLoadingDeadline } = useScaffoldReadContract({
    contractName: "ClawdPFP",
    functionName: "mintDeadline",
  });

  // Render from localStorage immediately so returning visitors don't see an
  // empty skeleton grid. The API call still fires to pick up any new mints
  // — but we only flip state if the response actually differs, so already-
  // rendered cards never re-mount (= no flashing).
  const [entries, setEntries] = useState<PfpEntry[] | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(GALLERY_CACHE_KEY);
        if (raw) {
          const cached = JSON.parse(raw) as PfpEntry[];
          if (Array.isArray(cached) && cached.length > 0) setEntries(cached);
        }
      } catch {
        window.localStorage.removeItem(GALLERY_CACHE_KEY);
      }
    }

    let cancelled = false;
    fetch("/api/pfps")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: PfpEntry[]) => {
        if (cancelled || !Array.isArray(data)) return;
        setEntries(prev => {
          // Skip the state update if nothing actually changed — avoids the
          // full grid re-render (and image re-decode) on a refresh where no
          // new mints exist.
          if (prev && prev.length === data.length && prev[0]?.id === data[0]?.id) {
            return prev;
          }
          return data;
        });
        try {
          window.localStorage.setItem(GALLERY_CACHE_KEY, JSON.stringify(data));
        } catch {
          // Quota exceeded on a very large collection — just skip the cache.
        }
      })
      .catch(() => {
        // Network / server blip: keep whatever we rendered from cache.
      })
      .finally(() => {
        if (!cancelled) setHasLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const isFrozen = mintDeadline ? BigInt(Math.floor(Date.now() / 1000)) > mintDeadline : false;
  const totalMinted = entries?.length ?? 0;
  const showSpinner = !hasLoaded && entries === null;

  return (
    <div className="flex items-center flex-col grow pt-10 pb-8">
      <div className="px-5 w-full max-w-6xl">
        {/* Hero + CTA */}
        <div className="text-center mb-8">
          <p className="text-base-content/70 max-w-lg mx-auto mb-2">
            Create a custom CLAWD lobster PFP and mint it as a gasless NFT on Ethereum.
          </p>
          <p className="text-sm text-base-content/60 max-w-lg mx-auto mb-6">
            Minting costs CV earned from staking{" "}
            <a href="https://larv.ai" target="_blank" rel="noopener noreferrer" className="link link-hover">
              $CLAWD on larv.ai
            </a>
            . The relayer pays gas, so you never send ETH from your wallet.
          </p>

          {!isFrozen && (
            <Link href="/generate" className="btn btn-primary btn-lg">
              Generate Your PFP
            </Link>
          )}
          {isFrozen && (
            <div className="alert max-w-lg mx-auto">
              <span className="text-sm font-semibold">
                Collection frozen &mdash; {totalMinted} PFP{totalMinted !== 1 ? "s" : ""} minted forever.
              </span>
            </div>
          )}
        </div>

        {/* Countdown timer */}
        <div className="mb-8">
          <CountdownTimer mintDeadline={mintDeadline} isLoading={isLoadingDeadline} />
        </div>

        {/* Gallery heading */}
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold">Gallery</h2>
          <p className="text-sm text-base-content/60">
            {totalMinted} PFP{totalMinted !== 1 ? "s" : ""} minted &middot;{" "}
            <a
              href={OPENSEA_COLLECTION_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="link link-hover link-primary"
            >
              View on OpenSea
            </a>
          </p>
        </div>

        {/* Loading state — only shown on first visit with nothing cached */}
        {showSpinner && (
          <div className="text-center py-12">
            <span className="loading loading-spinner loading-lg"></span>
            <p className="text-base-content/60 mt-4">Loading gallery...</p>
          </div>
        )}

        {/* Empty state */}
        {!showSpinner && totalMinted === 0 && (
          <div className="text-center py-12">
            <div className="text-6xl mb-4 opacity-30">🦞</div>
            {isFrozen ? (
              <p className="text-lg text-base-content/60">The minting window has closed. No PFPs were minted.</p>
            ) : (
              <p className="text-lg text-base-content/60">No PFPs minted yet. Be the first!</p>
            )}
          </div>
        )}

        {/* Gallery grid */}
        {totalMinted > 0 && entries && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {entries.map(entry => (
              <PFPCard
                key={entry.id}
                tokenId={entry.id}
                owner={entry.minter}
                image={entry.image}
                description={entry.description}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Home;
