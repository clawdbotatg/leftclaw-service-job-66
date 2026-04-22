"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { base } from "viem/chains";
import { useAccount, usePublicClient, useSignMessage, useSwitchChain } from "wagmi";
import { CountdownTimer } from "~~/components/clawd-pfp/CountdownTimer";
import { GenerateForm } from "~~/components/clawd-pfp/GenerateForm";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";
import { notification } from "~~/utils/scaffold-eth";

const MINT_CV_COST = 5_000_000;
const PFP_COST_URL = "https://leftclaw.services/api/pfp/cost";

// Keep the last generated (but not yet minted) PFP in localStorage keyed by
// wallet, so navigating away and back doesn't lose it. Expiry is enforced by
// the server's HMAC provenance (10 min), so naturally-expired entries can't
// be minted anyway — we just drop them on load.
const pendingPfpKey = (addr: string) => `pendingPfp:${addr.toLowerCase()}`;

// Bump this suffix whenever the signing flow changes in a way that could
// invalidate previously cached sigs (e.g. chain, message, encoding). Old
// keys will be ignored on load and garbage-collected on the next sign.
const cvSigKey = (addr: string) => `cvSig:v2:${addr.toLowerCase()}`;

// Map wagmi / viem signMessage errors to user-actionable copy. The default
// branch falls back to the wallet's own shortMessage if present, so we
// surface real detail (e.g. "User rejected the request") instead of the
// generic "Signature request failed" for every flavor of failure.
function friendlySigError(err: unknown): string {
  const e = err as { name?: string; code?: number | string; message?: string; shortMessage?: string };
  const name = e?.name ?? "";
  const code = e?.code;
  const msg = (e?.shortMessage || e?.message || "").toLowerCase();

  if (
    name === "UserRejectedRequestError" ||
    code === 4001 ||
    msg.includes("user rejected") ||
    msg.includes("user denied")
  ) {
    return "You rejected the signature request. Tap Generate again when you're ready.";
  }
  // MetaMask returns -32002 when another request is already pending in the
  // extension for this origin — the new request fails without a popup.
  if (name === "ResourceUnavailableRpcError" || code === -32002 || msg.includes("already pending")) {
    return "Your wallet already has a pending request. Open your wallet extension, approve or reject the previous prompt, then try again.";
  }
  if (name === "ConnectorNotConnectedError" || msg.includes("not connected") || msg.includes("no connector")) {
    return "Your wallet looks disconnected. Reconnect it and try again.";
  }
  // Wagmi's internal chain state is out of sync with the connector — most
  // commonly leftover state from an older deploy that chain-hopped to Base.
  // We auto-recover in getSignature; this copy is the fallback if recovery
  // also fails.
  if (msg.includes("current chain of the connector") || msg.includes("does not match the connection")) {
    return "Your wallet's chain is out of sync with the app. Refresh the page, or disconnect and reconnect your wallet.";
  }
  const detail = e?.shortMessage || e?.message;
  return `Signature request failed${detail ? `: ${detail}` : ""}. Open your wallet and try again.`;
}

function isChainMismatchError(err: unknown): boolean {
  const e = err as { message?: string; shortMessage?: string };
  const msg = (e?.shortMessage || e?.message || "").toLowerCase();
  return msg.includes("current chain of the connector") || msg.includes("does not match the connection");
}

const Generate: NextPage = () => {
  const { address: connectedAddress, isConnected, chain, connector } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { targetNetwork } = useTargetNetwork();
  const { switchChain, switchChainAsync } = useSwitchChain();
  // Used to sniff smart-wallet deployment on Base via getCode (below).
  const basePublicClient = usePublicClient({ chainId: base.id });

  const { data: mintDeadline, isLoading: isLoadingDeadline } = useScaffoldReadContract({
    contractName: "ClawdPFP",
    functionName: "mintDeadline",
  });

  const [cvSignature, setCvSignature] = useState<string | null>(null);
  const [generateCvCost, setGenerateCvCost] = useState<number | null>(null);
  // null = not yet checked, true = has code on Base (ERC-1271 smart wallet),
  // false = EOA. Only smart wallets need the Base chain-hop for signing.
  const [isSmartWallet, setIsSmartWallet] = useState<boolean | null>(null);

  useEffect(() => {
    if (!connectedAddress || !basePublicClient) {
      setIsSmartWallet(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const code = await basePublicClient.getCode({ address: connectedAddress });
        if (!cancelled) setIsSmartWallet(!!code && code !== "0x");
      } catch {
        // Leave as null on RPC hiccups — getSignature treats unknown as
        // "try the safe path (switch to Base)" so smart wallets still work.
        if (!cancelled) setIsSmartWallet(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectedAddress, basePublicClient]);

  // Fetch current generate price from LeftClaw. CORS is open and upstream
  // is edge-cached (max-age=30), so a direct browser fetch is cheap and the
  // price stays in sync with the server-side preflight without a passthrough.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(PFP_COST_URL);
        if (!res.ok) return;
        const data = (await res.json()) as { generateCvCost?: number };
        if (!cancelled && typeof data.generateCvCost === "number") {
          setGenerateCvCost(data.generateCvCost);
        }
      } catch {
        // Leave null — UI renders a "…" fallback rather than a stale number.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!connectedAddress) {
      setCvSignature(null);
      return;
    }
    // Opportunistically scrub the old (unversioned) key so stale sigs from
    // prior deploys can't shadow the new flow.
    window.localStorage.removeItem(`cvSignature:${connectedAddress.toLowerCase()}`);
    const stored = window.localStorage.getItem(cvSigKey(connectedAddress));
    setCvSignature(stored);
  }, [connectedAddress]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [isMinting, setIsMinting] = useState(false);
  // Hide the wrong-network screen while we're mid-flow — getSignature() hops
  // to Base and back, and we don't want the UI to flash "switch to Ethereum"
  // behind the wallet popups during that hop.
  const isOnWrongNetwork = isConnected && chain?.id !== targetNetwork.id && !isGenerating && !isMinting;
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

    // Upstream (leftclaw.services + larv.ai) verify the CV-spend sig on Base.
    // ERC-1271 wallets (Coinbase Smart Wallet, Safe) use replay-safe hashing
    // that binds the sig to block.chainid, so those MUST sign on Base.
    // EOAs (MetaMask, Rabby, etc.) verify via ecrecover, which is chain-
    // agnostic — forcing them to switch networks just confuses users and
    // breaks the signing flow if they reject the switch prompt. Only hop
    // chains when we've confirmed the account has code on Base.
    const needsBase = isSmartWallet === true;
    const originalChainId = chain?.id;
    let didSwitch = false;
    if (needsBase && originalChainId !== base.id) {
      try {
        await switchChainAsync({ chainId: base.id });
        didSwitch = true;
      } catch {
        setError("Please approve the network switch to Base in your wallet, then try again.");
        return null;
      }
    }

    const signAndCache = async () => {
      const sig = await signMessageAsync({ message: "larv.ai CV Spend" });
      setCvSignature(sig);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(cvSigKey(connectedAddress), sig);
      }
      return sig;
    };

    try {
      return await signAndCache();
    } catch (err) {
      // Wagmi's stored connection chain doesn't match what the connector
      // reports — almost always leftover state from a prior deploy that
      // chain-hopped to Base. Force-sync by switching wagmi's chain to what
      // the connector is actually on, then retry the sign once. If MetaMask
      // is already on that chain it resolves without a popup.
      if (isChainMismatchError(err)) {
        try {
          await switchChainAsync({ chainId: targetNetwork.id });
          return await signAndCache();
        } catch (retryErr) {
          err = retryErr;
        }
      }
      // Dump enough context that a screenshot of the console is diagnosable
      // without us needing to go back and forth with the user. Safe to log
      // — nothing here is a secret.
      const wagmiErr = err as { name?: string; code?: number | string; message?: string; shortMessage?: string };
      console.error("[cv-sign] signMessageAsync failed:", {
        connector: connector ? { id: connector.id, name: connector.name, type: connector.type } : null,
        chainId: chain?.id,
        isSmartWallet,
        error: {
          name: wagmiErr?.name,
          code: wagmiErr?.code,
          message: wagmiErr?.message,
          shortMessage: wagmiErr?.shortMessage,
        },
        raw: err,
      });
      // Defensively wipe any cached sig so a retry starts from a clean slate
      // (covers racy states where a stale cache snuck past the load effect).
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(cvSigKey(connectedAddress));
      }
      setCvSignature(null);
      setError(friendlySigError(err));
      return null;
    } finally {
      if (didSwitch && originalChainId && originalChainId !== base.id) {
        try {
          await switchChainAsync({ chainId: originalChainId });
        } catch {
          // Silent — user can switch manually if the wallet refuses.
        }
      }
    }
  }, [
    cvSignature,
    connectedAddress,
    chain?.id,
    connector,
    isSmartWallet,
    targetNetwork.id,
    signMessageAsync,
    switchChainAsync,
  ]);

  // Drop a cached signature that the server flagged as invalid so the next
  // action re-prompts the wallet. The user sees a friendly nudge and retries.
  const clearSignatureCache = useCallback(() => {
    if (typeof window !== "undefined" && connectedAddress) {
      window.localStorage.removeItem(cvSigKey(connectedAddress));
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
              `${data.error || "Your signature was rejected."} Your wallet will be asked to sign again on the next try.`,
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
            `${data.error || "Your signature was rejected."} Your wallet will be asked to sign again on the next try.`,
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
            Minting costs CV earned from staking{" "}
            <a href="https://larv.ai" target="_blank" rel="noopener noreferrer" className="link link-hover">
              $CLAWD on larv.ai
            </a>
            . The relayer pays gas, so you never send ETH from your wallet.
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
              Generate: {generateCvCost !== null ? generateCvCost.toLocaleString() : "…"} CV · Mint:{" "}
              {MINT_CV_COST.toLocaleString()} CV
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
              Generate: {generateCvCost !== null ? generateCvCost.toLocaleString() : "…"} CV | Mint:{" "}
              {MINT_CV_COST.toLocaleString()} CV
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
              <>
                <div className="text-xs text-base-content/60 bg-base-200/50 rounded-lg p-3 max-w-md mx-auto">
                  <span className="font-semibold">What you&apos;ll sign:</span> an off-chain message (&quot;larv.ai CV
                  Spend&quot;) that authorizes CV to be charged from your larv.ai balance. It&apos;s free, uses no gas,
                  and never sends funds from your wallet.
                </div>
                <GenerateForm
                  onGenerate={handleGenerate}
                  isGenerating={isGenerating}
                  disabled={false}
                  generateCvCost={generateCvCost}
                />
              </>
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
                    Generate Again ({generateCvCost !== null ? generateCvCost.toLocaleString() : "…"} CV)
                  </button>
                  {!isMinting && !cvSignature && (
                    <p className="text-xs text-base-content/60">
                      Your wallet will ask you to sign an off-chain message (&quot;larv.ai CV Spend&quot;). No gas, no
                      funds sent — the relayer pays gas for your mint.
                    </p>
                  )}
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
