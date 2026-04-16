import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import {
  CLAWDPFP_ABI,
  CLAWDPFP_ADDRESS,
  MINT_CV_COST,
  MIN_RELAYER_ETH,
  bgipfsAddBytes,
  bgipfsAddJson,
  bgipfsGatewayUrl,
  getCvBalance,
  getPublicClient,
  getRelayerAccount,
  getWalletClient,
  parseImageDataUrl,
  parseTokenIdFromReceiptLogs,
  spendCv,
} from "~~/lib/server/pfpApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Minting involves two IPFS uploads + a mainnet tx — allow longer than default.
export const maxDuration = 120;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(wallet: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const key = wallet.toLowerCase();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count += 1;
  return { allowed: true };
}

function decrementRateLimit(wallet: string) {
  const entry = rateLimitMap.get(wallet.toLowerCase());
  if (entry && entry.count > 0) entry.count -= 1;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      wallet?: string;
      imageDataUrl?: string;
      prompt?: string;
      signature?: string;
    };
    const { wallet, imageDataUrl, prompt, signature } = body;

    // --- Validate ---
    if (!wallet || !isAddress(wallet)) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }
    if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      return NextResponse.json({ error: "Image data URL is required" }, { status: 400 });
    }
    if (!prompt || typeof prompt !== "string" || prompt.length === 0 || prompt.length > 280) {
      return NextResponse.json({ error: "Prompt must be 1-280 characters" }, { status: 400 });
    }
    if (!signature || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return NextResponse.json({ error: "Signature is required and must be hex" }, { status: 400 });
    }

    const sanitizedPrompt = prompt.replace(/<[^>]*>/g, "").trim();
    if (sanitizedPrompt.length === 0) {
      return NextResponse.json({ error: "Prompt cannot be empty after sanitization" }, { status: 400 });
    }

    // --- Decode image early so we fail fast on bad payloads. ---
    let imageBuffer: Buffer;
    let imageContentType: string;
    try {
      const parsed = parseImageDataUrl(imageDataUrl);
      imageBuffer = parsed.buffer;
      imageContentType = parsed.contentType;
    } catch {
      return NextResponse.json({ error: "Image data URL could not be decoded" }, { status: 400 });
    }
    // Reject images that are suspiciously large or empty. Base PFP is ~200 KB.
    if (imageBuffer.length === 0 || imageBuffer.length > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "Image payload invalid (empty or >5 MB)" }, { status: 400 });
    }

    // --- Rate limit ---
    const rateCheck = checkRateLimit(wallet);
    if (!rateCheck.allowed) {
      const retryAfterSec = Math.ceil((rateCheck.retryAfterMs || 0) / 1000);
      return NextResponse.json(
        {
          error: `Rate limit exceeded. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.`,
          retryAfterSec,
        },
        { status: 429 },
      );
    }

    const publicClient = getPublicClient();

    // --- Preflight: mintDeadline ---
    let mintDeadline: bigint;
    try {
      mintDeadline = (await publicClient.readContract({
        address: CLAWDPFP_ADDRESS,
        abi: CLAWDPFP_ABI,
        functionName: "mintDeadline",
      })) as bigint;
    } catch (err) {
      console.error("mintDeadline read failed:", err);
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "Could not verify mint deadline. Try again shortly." }, { status: 503 });
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    // 60s grace: don't start a mint we know we can't confirm before the deadline.
    if (nowSec + 60n >= mintDeadline) {
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "The CLAWD PFP minting window has closed." }, { status: 410 });
    }

    // --- Preflight: relayer balance ---
    let relayerAccount;
    try {
      relayerAccount = getRelayerAccount();
    } catch (err) {
      console.error("relayer account init failed:", err);
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "Minting temporarily unavailable (relayer not configured)." }, { status: 503 });
    }
    const relayerBalance = await publicClient.getBalance({ address: relayerAccount.address });
    if (relayerBalance < MIN_RELAYER_ETH) {
      decrementRateLimit(wallet);
      return NextResponse.json(
        {
          error: "Minting temporarily unavailable (relayer low on gas).",
          reason: "relayer_low_balance",
        },
        { status: 503 },
      );
    }

    // --- Preflight: CV balance ---
    const balance = await getCvBalance(wallet);
    if (balance.balance < MINT_CV_COST) {
      decrementRateLimit(wallet);
      return NextResponse.json(
        {
          error: `Insufficient CV. Need ${MINT_CV_COST.toLocaleString()} CV, have ${balance.balance.toLocaleString()}.`,
          currentBalance: balance.balance,
          required: MINT_CV_COST,
        },
        { status: 402 },
      );
    }

    // --- Predict the upcoming tokenId (best-effort, for metadata name) ---
    let predictedTokenId: bigint | null = null;
    try {
      predictedTokenId = (await publicClient.readContract({
        address: CLAWDPFP_ADDRESS,
        abi: CLAWDPFP_ABI,
        functionName: "totalSupply",
      })) as bigint;
    } catch {
      predictedTokenId = null;
    }

    // --- Charge CV FIRST (user-facing failures here mean no IPFS/tx cost) ---
    const charge = await spendCv({ wallet, amount: MINT_CV_COST, signature });
    if (!charge.ok) {
      decrementRateLimit(wallet);
      return NextResponse.json(
        {
          error: `CV charge failed: ${charge.error || "unknown"}`,
        },
        { status: charge.status === 402 ? 402 : 502 },
      );
    }

    // From this point on we've taken the user's CV. Any failure needs to be
    // logged so it can be reconciled manually (larv.ai doesn't support
    // programmatic refunds). We still report a graceful error to the user.
    const logCvCharged = (detail: string) =>
      console.error(
        `[MINT_RECONCILE] wallet=${wallet} charged=${MINT_CV_COST} CV but ${detail}. Manual refund required.`,
      );

    // --- Pin image to BGIPFS ---
    let imageCid: string;
    try {
      const upload = await bgipfsAddBytes(
        imageBuffer,
        `clawd-pfp.${imageContentType.split("/")[1] || "png"}`,
        imageContentType,
      );
      imageCid = upload.cid;
    } catch (err) {
      logCvCharged(`BGIPFS image upload failed: ${(err as Error).message}`);
      return NextResponse.json(
        {
          error: "Image pinning failed after CV was charged. Please contact support for a refund.",
          reconcile: { wallet, amount: MINT_CV_COST },
        },
        { status: 502 },
      );
    }

    // --- Build + pin metadata JSON ---
    const imageGatewayUrl = bgipfsGatewayUrl(imageCid);
    const metadataName = predictedTokenId !== null ? `CLAWD PFP #${predictedTokenId.toString()}` : "CLAWD PFP";
    const metadata = {
      name: metadataName,
      description: sanitizedPrompt,
      image: imageGatewayUrl,
      external_url: "https://leftclaw.services",
      attributes: [
        { trait_type: "Prompt", value: sanitizedPrompt },
        { trait_type: "Minted By", value: wallet },
      ],
    };
    let metadataCid: string;
    try {
      const upload = await bgipfsAddJson(metadata, "metadata.json");
      metadataCid = upload.cid;
    } catch (err) {
      logCvCharged(`BGIPFS metadata upload failed: ${(err as Error).message}`);
      return NextResponse.json(
        {
          error: "Metadata pinning failed after CV was charged. Please contact support for a refund.",
          reconcile: { wallet, amount: MINT_CV_COST, imageCid },
        },
        { status: 502 },
      );
    }
    const metadataURI = bgipfsGatewayUrl(metadataCid);

    // --- Simulate the mint before sending ---
    try {
      await publicClient.simulateContract({
        account: relayerAccount.address,
        address: CLAWDPFP_ADDRESS,
        abi: CLAWDPFP_ABI,
        functionName: "mint",
        args: [wallet as `0x${string}`, metadataURI],
      });
    } catch (err) {
      logCvCharged(`mint simulation reverted: ${(err as Error).message}`);
      return NextResponse.json(
        {
          error: "Mint simulation failed. Your CV has been charged — please contact support.",
          reconcile: { wallet, amount: MINT_CV_COST, imageCid, metadataCid },
        },
        { status: 502 },
      );
    }

    // --- Send mint tx from relayer ---
    let txHash: `0x${string}`;
    try {
      const walletClient = getWalletClient();
      txHash = await walletClient.writeContract({
        address: CLAWDPFP_ADDRESS,
        abi: CLAWDPFP_ABI,
        functionName: "mint",
        args: [wallet as `0x${string}`, metadataURI],
        chain: walletClient.chain,
        account: walletClient.account,
      });
    } catch (err) {
      logCvCharged(`mint write failed: ${(err as Error).message}`);
      return NextResponse.json(
        {
          error: "Mint transaction failed to submit. Your CV has been charged — please contact support.",
          reconcile: { wallet, amount: MINT_CV_COST, imageCid, metadataCid },
        },
        { status: 502 },
      );
    }

    // --- Wait for receipt + parse tokenId ---
    let tokenIdFromReceipt: bigint | null = null;
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
      if (receipt.status !== "success") {
        logCvCharged(`mint tx reverted on-chain (${txHash})`);
        return NextResponse.json(
          {
            error: "Mint transaction reverted on-chain. Your CV has been charged — please contact support.",
            txHash,
            reconcile: { wallet, amount: MINT_CV_COST, imageCid, metadataCid, txHash },
          },
          { status: 502 },
        );
      }
      tokenIdFromReceipt = parseTokenIdFromReceiptLogs(receipt.logs);
    } catch (err) {
      // Tx is broadcast; we just couldn't wait for the receipt. Return what
      // we have — the frontend can still show the Etherscan link.
      console.error("waitForTransactionReceipt failed:", err);
    }

    const finalTokenId =
      tokenIdFromReceipt !== null
        ? Number(tokenIdFromReceipt)
        : predictedTokenId !== null
          ? Number(predictedTokenId)
          : null;

    return NextResponse.json({
      txHash,
      tokenId: finalTokenId,
      tokenURI: metadataURI,
      imageCid,
      metadataCid,
      imageUrl: imageGatewayUrl,
      cvSpent: MINT_CV_COST,
      newBalance: charge.newBalance,
    });
  } catch (error) {
    console.error("Mint API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
