"use client";

import Link from "next/link";
import type { NextPage } from "next";
import { CountdownTimer } from "~~/components/clawd-pfp/CountdownTimer";
import { PFPCard } from "~~/components/clawd-pfp/PFPCard";
import { useScaffoldEventHistory, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

const Gallery: NextPage = () => {
  // Read mint deadline from contract
  const { data: mintDeadline, isLoading: isLoadingDeadline } = useScaffoldReadContract({
    contractName: "ClawdPFP",
    functionName: "mintDeadline",
  });

  // Read PFPMinted events
  const { data: mintEvents, isLoading: isLoadingEvents } = useScaffoldEventHistory({
    contractName: "ClawdPFP",
    eventName: "PFPMinted",
    fromBlock: 0n,
    watch: true,
  });

  const isFrozen = mintDeadline ? BigInt(Math.floor(Date.now() / 1000)) > mintDeadline : false;
  const totalMinted = mintEvents?.length ?? 0;

  return (
    <div className="flex items-center flex-col grow pt-10 pb-8">
      <div className="px-5 w-full max-w-6xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2">CLAWD PFP Gallery</h1>
          {isFrozen ? (
            <p className="text-lg text-base-content/70">
              Collection Frozen &mdash; {totalMinted} PFP{totalMinted !== 1 ? "s" : ""} minted forever
            </p>
          ) : (
            <p className="text-lg text-base-content/70">
              {totalMinted} PFP{totalMinted !== 1 ? "s" : ""} minted
            </p>
          )}
        </div>

        {/* Countdown timer */}
        <div className="mb-8">
          <CountdownTimer mintDeadline={mintDeadline} isLoading={isLoadingDeadline} />
        </div>

        {/* Loading state */}
        {isLoadingEvents && (
          <div className="text-center py-12">
            <span className="loading loading-spinner loading-lg"></span>
            <p className="text-base-content/60 mt-4">Loading gallery...</p>
          </div>
        )}

        {/* Empty state */}
        {!isLoadingEvents && totalMinted === 0 && (
          <div className="text-center py-12">
            <div className="text-6xl mb-4 opacity-30">🦞</div>
            {isFrozen ? (
              <p className="text-lg text-base-content/60">The minting window has closed. No PFPs were minted.</p>
            ) : (
              <>
                <p className="text-lg text-base-content/60 mb-4">No PFPs minted yet. Be the first!</p>
                <Link href="/" className="btn btn-primary">
                  Generate a PFP
                </Link>
              </>
            )}
          </div>
        )}

        {/* Gallery grid */}
        {!isLoadingEvents && totalMinted > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {mintEvents?.map(event => {
              const tokenId = Number(event.args.tokenId);
              const to = event.args.to as string;
              const prompt = event.args.tokenURI as string;

              return <PFPCard key={tokenId} tokenId={tokenId} owner={to} prompt={prompt} />;
            })}
          </div>
        )}

        {/* Back to generate link */}
        {!isFrozen && (
          <div className="text-center mt-8">
            <Link href="/" className="link link-hover text-base-content/60">
              &larr; Generate a PFP
            </Link>
          </div>
        )}
      </div>
    </div>
  );
};

export default Gallery;
