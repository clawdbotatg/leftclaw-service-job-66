"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";
import { CountdownTimer } from "~~/components/clawd-pfp/CountdownTimer";
import { GenerateForm } from "~~/components/clawd-pfp/GenerateForm";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { notification } from "~~/utils/scaffold-eth";

const GENERATE_CV_COST = 500_000;
const MINT_CV_COST = 5_000_000;

// Keep the last generated (but not yet minted) PFP in localStorage keyed by
// wallet, so navigating away and back doesn't lose it. Expiry is enforced by
// the server's HMAC provenance (10 min), so naturally-expired entries can't
// be minted anyway — we just drop them on load.
const pendingPfpKey = (addr: string) => `pendingPfp:${addr.toLowerCase()}`;

const Generate: NextPage = () => {
  const { address: connectedAddress, isConnected, chain } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { targetNetwork } = useTargetNetwork();
  const { switchChain } = useSwitchChain();
  const isOnWrongNetwork = isConnected && chain?.id !== targetNetwork.id;

  const { data: mintDeadline, isLoading: isLoadingDeadline } = useScaffoldReadContract({
    contractName: "ClawdPFP",
    functionName: "mintDeadline",
  });

  const [cvSignature, setCvSignature] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!connectedAddress) {
      setCvSignature(null);
      return;
    }
    const stored = window.localStorage.getItem(`cvSignature:${connectedAddress.toLowerCase()}`);
    setCvSignature(stored);
  }, [connectedAddress]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [isMinting, setIsMinting] = useState(false);
  // Time-based estimate of where we are in the mint flow (0=Charging, 1=Pinning, 2=Minting, 3=Confirming)
  const [mintStage, setMintStage] = useState(0);

  useEffect(() => {
    if (!isMinting) {
      setMintStage(0);
      return;
    }
    // Timers reflect the real /api/mint flow:
    //   ~0-2s   preflight + CV charge     -> Charging CV
    //   ~2-7s   two BGIPFS pins + sim     -> Pinning to IPFS
    //   ~7-9s   tx submission             -> Minting on Ethereum
    //   ~9-20s  waitForTransactionReceipt -> Confirming
    // The receipt wait is the longest step (~12s on mainnet), so advancing to
    // Confirming at 9s lines up with when we're actually waiting on block
    // inclusion rather than lingering on an earlier label.
    const t1 = setTimeout(() => setMintStage(1), 2000);
    const t2 = setTimeout(() => setMintStage(2), 6000);
    const t3 = setTimeout(() => setMintStage(3), 11000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [isMinting]);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [generatedPrompt, setGeneratedPrompt] = useState<string | null>(null);
  const [generatedProvenance, setGeneratedProvenance] = useState<{
    imageSha256: string;
    wallet: string;
    expiry: number;
    hmac: string;
  } | null>(null);
  const [mintResult, setMintResult] = useState<{
    txHash: string;
    tokenId: number;
  } | null>(null);
  // Tx was broadcast but didn't confirm in the server's wait window. Show a
  // distinct state with an Etherscan link instead of a fake "success" toast.
  const [pendingMint, setPendingMint] = useState<{ txHash: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the pending (unminted) PFP from localStorage when wallet changes.
  // Drops entries whose provenance has expired so the user can't try to mint
  // something the server will reject anyway.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!connectedAddress) {
      setGeneratedImage(null);
      setGeneratedPrompt(null);
      setGeneratedProvenance(null);
      return;
    }
    const raw = window.localStorage.getItem(pendingPfpKey(connectedAddress));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        image?: string;
        prompt?: string;
        provenance?: { imageSha256: string; wallet: string; expiry: number; hmac: string } | null;
      };
      const nowSec = Math.floor(Date.now() / 1000);
      if (parsed.provenance && parsed.provenance.expiry <= nowSec) {
        window.localStorage.removeItem(pendingPfpKey(connectedAddress));
        return;
      }
      if (parsed.image) setGeneratedImage(parsed.image);
      if (parsed.prompt) setGeneratedPrompt(parsed.prompt);
      if (parsed.provenance) setGeneratedProvenance(parsed.provenance);
    } catch {
      window.localStorage.removeItem(pendingPfpKey(connectedAddress));
    }
  }, [connectedAddress]);

  const isFrozen = mintDeadline ? BigInt(Math.floor(Date.now() / 1000)) > mintDeadline : false;

  const getSignature = useCallback(async (): Promise<string | null> => {
    if (cvSignature) return cvSignature;
    if (!connectedAddress) return null;

    try {
      const sig = await signMessageAsync({ message: "larv.ai CV Spend" });
      setCvSignature(sig);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(`cvSignature:${connectedAddress.toLowerCase()}`, sig);
      }
      return sig;
    } catch {
      setError("Signature rejected. You must sign the message to proceed.");
      return null;
    }
  }, [cvSignature, connectedAddress, signMessageAsync]);

  // Drop a cached signature that the server flagged as invalid so the next
  // action re-prompts the wallet. The user sees a friendly nudge and retries.
  const clearSignatureCache = useCallback(() => {
    if (typeof window !== "undefined" && connectedAddress) {
      window.localStorage.removeItem(`cvSignature:${connectedAddress.toLowerCase()}`);
    }
    setCvSignature(null);
  }, [connectedAddress]);

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
          if (data.code === "bad_signature") {
            clearSignatureCache();
            setError(
              `${data.error || "Your signature was rejected."} Your wallet will be asked to sign again on the next try. (If you're using a smart contract wallet like Safe, minting may not work.)`,
            );
          } else {
            setError(data.error || "Image generation failed. Please try again.");
          }
          return;
        }

        setGeneratedImage(data.image);
        setGeneratedPrompt(data.prompt);
        setGeneratedProvenance(data.provenance ?? null);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            pendingPfpKey(connectedAddress),
            JSON.stringify({
              image: data.image,
              prompt: data.prompt,
              provenance: data.provenance ?? null,
            }),
          );
        }
        notification.success("PFP generated successfully!");
      } catch (err) {
        setError(`Image generation failed: ${(err as Error).message || "network error"}. Please try again.`);
      } finally {
        setIsGenerating(false);
      }
    },
    [connectedAddress, getSignature, clearSignatureCache],
  );

  const handleMint = useCallback(async () => {
    if (!connectedAddress || !generatedImage || !generatedPrompt) return;

    setError(null);
    setPendingMint(null);
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
          provenance: generatedProvenance,
        }),
      });

      const data = await res.json();

      // 202: broadcast but still pending. Don't claim success — show the
      // Etherscan link so the user can see the actual outcome.
      if (res.status === 202 && data.txHash) {
        setPendingMint({
          txHash: data.txHash,
          message: data.error || "Your transaction is still pending. Check Etherscan for the latest status.",
        });
        return;
      }

      if (!res.ok) {
        if (data.code === "bad_signature") {
          clearSignatureCache();
          setError(
            `${data.error || "Your signature was rejected."} Your wallet will be asked to sign again on the next try. (If you're using a smart contract wallet like Safe, minting may not work.)`,
          );
          return;
        }
        // Surface the backend error verbatim — it now includes code, txHash,
        // reconcile info when applicable, so the user can take action.
        const verbose = [data.error || "Minting failed. Please try again."];
        if (data.txHash) verbose.push(`tx: ${data.txHash}`);
        setError(verbose.join(" — "));
        return;
      }

      setMintResult({
        txHash: data.txHash,
        tokenId: data.tokenId,
      });
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(pendingPfpKey(connectedAddress));
      }
      notification.success("NFT minted successfully!");
    } catch (err) {
      setError(`Minting failed: ${(err as Error).message || "network error"}. Please try again.`);
    } finally {
      setIsMinting(false);
    }
  }, [connectedAddress, generatedImage, generatedPrompt, generatedProvenance, getSignature, clearSignatureCache]);

  const handleGenerateAnother = () => {
    setGeneratedImage(null);
    setGeneratedPrompt(null);
    setGeneratedProvenance(null);
    setMintResult(null);
    setPendingMint(null);
    setError(null);
    if (typeof window !== "undefined" && connectedAddress) {
      window.localStorage.removeItem(pendingPfpKey(connectedAddress));
    }
  };

  return (
    <div className="flex items-center flex-col grow pt-10 pb-8">
      <div className="px-5 w-full max-w-2xl">
        {/* Description */}
        <div className="text-center mb-8">
          <p className="text-base-content/70 max-w-md mx-auto">
            Create a custom CLAWD lobster PFP and mint it as a gasless NFT on Ethereum.
          </p>
          <p className="text-sm text-base-content/60 max-w-md mx-auto mt-3">
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
            <Link href="/" className="btn btn-primary btn-lg">
              View Gallery
            </Link>
          </div>
        )}

        {/* Not connected state */}
        {!isConnected && !isFrozen && (
          <div className="text-center space-y-4">
            <p className="text-lg text-base-content/70">Connect your wallet to generate a PFP.</p>
            <div className="flex justify-center">
              <RainbowKitCustomConnectButton />
            </div>
            <div className="text-sm text-base-content/50">
              Generate: {GENERATE_CV_COST.toLocaleString()} CV · Mint: {MINT_CV_COST.toLocaleString()} CV
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
            <div className="flex justify-center items-center gap-2 text-sm">
              <span className="opacity-60">Connected:</span>
              <Address address={connectedAddress} />
            </div>

            <div className="text-center text-sm text-base-content/60">
              Generate: {GENERATE_CV_COST.toLocaleString()} CV | Mint: {MINT_CV_COST.toLocaleString()} CV
            </div>

            {error && (
              <div className="alert alert-error">
                <span>{error}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </div>
            )}

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
                  <Link href="/" className="btn btn-outline">
                    View in Gallery
                  </Link>
                  <button className="btn btn-primary" onClick={handleGenerateAnother}>
                    Generate Another
                  </button>
                </div>
              </div>
            )}

            {pendingMint && !mintResult && (
              <div className="card bg-base-100 shadow-xl p-6 text-center">
                {generatedImage && (
                  <div className="mb-4 flex justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={generatedImage} alt="Pending CLAWD PFP" className="w-64 h-64 rounded-xl object-cover" />
                  </div>
                )}
                <h2 className="text-2xl font-bold mb-2">Transaction Pending</h2>
                <p className="text-warning text-sm mb-4">{pendingMint.message}</p>
                <a
                  href={`https://etherscan.io/tx/${pendingMint.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="link link-primary mb-4 block font-mono text-xs break-all"
                >
                  {pendingMint.txHash}
                </a>
                <p className="text-xs text-base-content/60 mb-4">
                  Your CV has been charged. If the transaction doesn&apos;t confirm in a few minutes, please contact
                  support with the hash above for a refund.
                </p>
                <div className="flex gap-4 justify-center">
                  <Link href="/" className="btn btn-outline">
                    Back to Gallery
                  </Link>
                  <button className="btn btn-primary" onClick={() => setPendingMint(null)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {!mintResult && !pendingMint && !generatedImage && (
              <GenerateForm onGenerate={handleGenerate} isGenerating={isGenerating} disabled={false} />
            )}

            {generatedImage && !mintResult && !pendingMint && (
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
                      {["Charging CV", "Pinning to IPFS", "Minting on Ethereum", "Confirming"].map((label, i) => (
                        <li key={label} className={`step ${i <= mintStage ? "step-primary" : ""}`}>
                          <span className="flex items-center gap-2">
                            {label}
                            {i === mintStage && <span className="loading loading-spinner loading-xs"></span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!isFrozen && (
          <div className="text-center mt-8">
            <Link href="/" className="link link-hover text-base-content/60">
              &larr; Back to Gallery
            </Link>
          </div>
        )}
      </div>
    </div>
  );
};

export default Generate;
