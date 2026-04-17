"use client";

import Link from "next/link";
import type { NextPage } from "next";
import { CountdownTimer } from "~~/components/clawd-pfp/CountdownTimer";
import { PFPCard } from "~~/components/clawd-pfp/PFPCard";
import { useScaffoldEventHistory, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

const OPENSEA_COLLECTION_URL = "https://opensea.io/assets/ethereum/0xb5741b033c45330a34952436a34b1b25a208af10";

const Home: NextPage = () => {
  const { data: mintDeadline, isLoading: isLoadingDeadline } = useScaffoldReadContract({
    contractName: "ClawdPFP",
    functionName: "mintDeadline",
  });

  const { data: mintEvents, isLoading: isLoadingEvents } = useScaffoldEventHistory({
    contractName: "ClawdPFP",
    eventName: "PFPMinted",
    watch: true,
  });

  const isFrozen = mintDeadline ? BigInt(Math.floor(Date.now() / 1000)) > mintDeadline : false;
  const totalMinted = mintEvents?.length ?? 0;

  return (
    <div className="flex items-center flex-col grow pt-10 pb-8">
      <div className="px-5 w-full max-w-6xl">
        {/* Hero + CTA */}
        <div className="text-center mb-8">
          <p className="text-base-content/70 max-w-lg mx-auto mb-2">
            Create a custom CLAWD lobster PFP and mint it as a gasless NFT on Ethereum.
          </p>
          <p className="text-sm text-base-content/60 max-w-lg mx-auto mb-6">
            Powered by the{" "}
            <a href="https://leftclaw.services" target="_blank" rel="noopener noreferrer" className="link link-hover">
              leftclaw.services
            </a>{" "}
            pipeline. Minting uses CV earned from staking{" "}
            <a href="https://larv.ai" target="_blank" rel="noopener noreferrer" className="link link-hover">
              $CLAWD on larv.ai
            </a>
            .
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
              <p className="text-lg text-base-content/60">No PFPs minted yet. Be the first!</p>
            )}
          </div>
        )}

        {/* Gallery grid */}
        {!isLoadingEvents && totalMinted > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {mintEvents?.map(event => {
              const tokenId = Number(event.args.tokenId);
              const to = event.args.to as string;
              const tokenUri = event.args.tokenURI as string;

              return <PFPCard key={tokenId} tokenId={tokenId} owner={to} tokenUri={tokenUri} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default Home;
