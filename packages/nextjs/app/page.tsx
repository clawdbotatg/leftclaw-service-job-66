"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";
import { CountdownTimer } from "~~/components/clawd-pfp/CountdownTimer";
import { GenerateForm } from "~~/components/clawd-pfp/GenerateForm";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { notification } from "~~/utils/scaffold-eth";

const GENERATE_CV_COST = 500_000;
const MINT_CV_COST = 5_000_000;

const Home: NextPage = () => {
  const { address: connectedAddress, isConnected, chain } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { targetNetwork } = useTargetNetwork();
  const { switchChain } = useSwitchChain();
  const isOnWrongNetwork = isConnected && chain?.id !== targetNetwork.id;

  // Contract reads
  const { data: mintDeadline, isLoading: isLoadingDeadline } = useScaffoldReadContract({
    contractName: "ClawdPFP",
    functionName: "mintDeadline",
  });

  // Local state
  const [cvSignature, setCvSignature] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isMinting, setIsMinting] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [generatedPrompt, setGeneratedPrompt] = useState<string | null>(null);
  const [mintResult, setMintResult] = useState<{
    txHash: string;
    tokenId: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Check if deadline has passed
  const isFrozen = mintDeadline ? BigInt(Math.floor(Date.now() / 1000)) > mintDeadline : false;

  // Get or request CV spend signature
  const getSignature = useCallback(async (): Promise<string | null> => {
    if (cvSignature) return cvSignature;

    try {
      const sig = await signMessageAsync({ message: "larv.ai CV Spend" });
      setCvSignature(sig);
      return sig;
    } catch {
      setError("Signature rejected. You must sign the message to proceed.");
      return null;
    }
  }, [cvSignature, signMessageAsync]);

  // Generate PFP
  const handleGenerate = useCallback(
    async (prompt: string) => {
      if (!connectedAddress) return;

      setError(null);
      setIsGenerating(true);
      setMintResult(null);

      try {
        const sig = await getSignature();
        if (!sig) {
          setIsGenerating(false);
          return;
        }

        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wallet: connectedAddress,
            prompt,
            signature: sig,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "Image generation failed. Please try again.");
          return;
        }

        setGeneratedImage(data.image);
        setGeneratedPrompt(data.prompt);
        notification.success("PFP generated successfully!");
      } catch {
        setError("Image generation failed. Please try again.");
      } finally {
        setIsGenerating(false);
      }
    },
    [connectedAddress, getSignature],
  );

  // Mint NFT
  const handleMint = useCallback(async () => {
    if (!connectedAddress || !generatedImage || !generatedPrompt) return;

    setError(null);
    setIsMinting(true);

    try {
      const sig = await getSignature();
      if (!sig) {
        setIsMinting(false);
        return;
      }

      const res = await fetch("/api/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: connectedAddress,
          imageDataUrl: generatedImage,
          prompt: generatedPrompt,
          signature: sig,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Minting failed. Please try again.");
        return;
      }

      setMintResult({
        txHash: data.txHash,
        tokenId: data.tokenId,
      });
      notification.success("NFT minted successfully!");
    } catch {
      setError("Minting failed. Please try again.");
    } finally {
      setIsMinting(false);
    }
  }, [connectedAddress, generatedImage, generatedPrompt, getSignature]);

  // Reset to generate another
  const handleGenerateAnother = () => {
    setGeneratedImage(null);
    setGeneratedPrompt(null);
    setMintResult(null);
    setError(null);
  };

  return (
    <div className="flex items-center flex-col grow pt-10 pb-8">
      <div className="px-5 w-full max-w-2xl">
        {/* Title and description */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2">CLAWD PFP Generator</h1>
          <p className="text-base-content/70 max-w-md mx-auto">
            Create a custom CLAWD lobster PFP and mint it as an NFT on Ethereum. No gas needed &mdash; we cover it.
          </p>
        </div>

        {/* Countdown timer */}
        <div className="mb-8">
          <CountdownTimer mintDeadline={mintDeadline} isLoading={isLoadingDeadline} />
        </div>

        {/* Frozen state */}
        {isFrozen && (
          <div className="text-center">
            <div className="alert mb-6">
              <span className="text-lg font-semibold">
                The CLAWD PFP collection is permanently frozen. No new PFPs can be generated or minted.
              </span>
            </div>
            <Link href="/gallery" className="btn btn-primary btn-lg">
              View Gallery
            </Link>
          </div>
        )}

        {/* Not connected state */}
        {!isConnected && !isFrozen && (
          <div className="text-center">
            <p className="text-lg text-base-content/60 mb-4">Connect your wallet to get started</p>
            <div className="text-sm text-base-content/40">
              Generate: {GENERATE_CV_COST.toLocaleString()} CV | Mint: {MINT_CV_COST.toLocaleString()} CV
            </div>
          </div>
        )}

        {/* Wrong network state */}
        {isOnWrongNetwork && !isFrozen && (
          <div className="text-center">
            <div className="alert alert-warning mb-6">
              <span className="text-lg font-semibold">Please switch to {targetNetwork.name} to continue.</span>
            </div>
            <button className="btn btn-primary btn-lg" onClick={() => switchChain?.({ chainId: targetNetwork.id })}>
              Switch to {targetNetwork.name}
            </button>
          </div>
        )}

        {/* Connected, active state */}
        {isConnected && !isFrozen && !isOnWrongNetwork && (
          <div className="space-y-6">
            {/* Connected address */}
            <div className="flex justify-center items-center gap-2 text-sm">
              <span className="opacity-60">Connected:</span>
              <Address address={connectedAddress} />
            </div>

            {/* Cost breakdown */}
            <div className="text-center text-sm text-base-content/60">
              Generate: {GENERATE_CV_COST.toLocaleString()} CV | Mint: {MINT_CV_COST.toLocaleString()} CV
            </div>

            {/* Error display */}
            {error && (
              <div className="alert alert-error">
                <span>{error}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </div>
            )}

            {/* Mint success state */}
            {mintResult && (
              <div className="card bg-base-100 shadow-xl p-6 text-center">
                {generatedImage && (
                  <div className="mb-4 flex justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={generatedImage}
                      alt={`CLAWD PFP #${mintResult.tokenId}`}
                      className="w-64 h-64 rounded-xl object-cover"
                    />
                  </div>
                )}
                <h2 className="text-2xl font-bold mb-2">CLAWD PFP #{mintResult.tokenId}</h2>
                <p className="text-success font-semibold mb-4">Minted successfully!</p>
                <a
                  href={`https://etherscan.io/tx/${mintResult.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="link link-primary mb-4 block"
                >
                  View on Etherscan
                </a>
                <div className="flex gap-4 justify-center">
                  <Link href="/gallery" className="btn btn-outline">
                    View in Gallery
                  </Link>
                  <button className="btn btn-primary" onClick={handleGenerateAnother}>
                    Generate Another
                  </button>
                </div>
              </div>
            )}

            {/* Generate form (only when no mint result showing) */}
            {!mintResult && !generatedImage && (
              <GenerateForm onGenerate={handleGenerate} isGenerating={isGenerating} disabled={false} />
            )}

            {/* Generated image preview */}
            {generatedImage && !mintResult && (
              <div className="card bg-base-100 shadow-xl p-6 text-center">
                <div className="mb-4 flex justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={generatedImage} alt="Generated CLAWD PFP" className="w-64 h-64 rounded-xl object-cover" />
                </div>
                {generatedPrompt && (
                  <p className="text-sm text-base-content/60 italic mb-4">&quot;{generatedPrompt}&quot;</p>
                )}

                <div className="flex flex-col gap-3">
                  <button className="btn btn-primary btn-lg w-full" onClick={handleMint} disabled={isMinting}>
                    {isMinting ? (
                      <>
                        <span className="loading loading-spinner loading-sm"></span>
                        Minting on Ethereum...
                      </>
                    ) : (
                      `Mint as NFT (${MINT_CV_COST.toLocaleString()} CV)`
                    )}
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={handleGenerateAnother} disabled={isMinting}>
                    Generate Again ({GENERATE_CV_COST.toLocaleString()} CV)
                  </button>
                </div>

                {isMinting && (
                  <div className="mt-4 text-sm text-base-content/60">
                    <ul className="steps steps-vertical text-left">
                      <li className="step step-primary">Charging CV</li>
                      <li className="step step-primary">Pinning to IPFS</li>
                      <li className="step">Minting on Ethereum</li>
                      <li className="step">Confirming</li>
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Gallery link */}
        {!isFrozen && (
          <div className="text-center mt-8">
            <Link href="/gallery" className="link link-hover text-base-content/60">
              Browse the Gallery &rarr;
            </Link>
          </div>
        )}
      </div>
    </div>
  );
};

export default Home;
