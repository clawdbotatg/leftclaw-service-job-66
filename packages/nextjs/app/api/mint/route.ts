import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
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
  sha256ImageBase64,
  spendCv,
  verifyImageProvenance,
} from "~~/lib/server/pfpApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Minting involves two IPFS uploads + a mainnet tx — allow longer than default.
export const maxDuration = 120;

// Stage logger — emits one line per mint lifecycle step, tagged with a short
// request id + wallet so multi-request traces can be reassembled from Vercel
// logs. Kept one-line so `vercel logs -q "[MINT]"` is useful.
function mintLog(reqId: string, wallet: string, stage: string, extra: Record<string, unknown> = {}) {
  const parts = [`[MINT]`, `reqId=${reqId}`, `wallet=${wallet}`, `stage=${stage}`];
  for (const [k, v] of Object.entries(extra)) {
    const val = typeof v === "bigint" ? v.toString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${val}`);
  }
  console.log(parts.join(" "));
}

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
  const reqId = randomBytes(4).toString("hex");
  const t0 = Date.now();
  let wallet = "unknown";
  try {
    const body = (await request.json().catch(() => ({}))) as {
      wallet?: string;
      imageDataUrl?: string;
      prompt?: string;
      signature?: string;
      provenance?: {
        imageSha256?: unknown;
        wallet?: unknown;
        expiry?: unknown;
        hmac?: unknown;
      };
    };
    const { wallet: bodyWallet, imageDataUrl, prompt, signature, provenance } = body;
    wallet = bodyWallet || "unknown";

    // --- Validate ---
    if (!bodyWallet || !isAddress(bodyWallet)) {
      mintLog(reqId, wallet, "reject", { reason: "invalid_wallet" });
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }
    if (!imageDataUrl || typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      mintLog(reqId, wallet, "reject", { reason: "bad_image_data_url" });
      return NextResponse.json({ error: "Image data URL is required" }, { status: 400 });
    }
    if (!prompt || typeof prompt !== "string" || prompt.length === 0 || prompt.length > 280) {
      mintLog(reqId, wallet, "reject", { reason: "bad_prompt", len: prompt?.length });
      return NextResponse.json({ error: "Prompt must be 1-280 characters" }, { status: 400 });
    }
    if (!signature || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      mintLog(reqId, wallet, "reject", { reason: "bad_signature_format", len: signature?.length });
      return NextResponse.json({ error: "Signature is required and must be hex" }, { status: 400 });
    }
    // Standard ECDSA = 0x + 130 hex = 132 chars. Longer signatures are
    // expected for ERC-1271 / ERC-6492 (smart contract wallets) and verified
    // via publicClient.verifyMessage below rather than rejected on length.
    const isEoaLengthSig = signature.length === 132;
    mintLog(reqId, wallet, "start", { promptLen: prompt.length, sigLen: signature.length, isEoaLengthSig });

    const sanitizedPrompt = prompt.replace(/<[^>]*>/g, "").trim();
    if (sanitizedPrompt.length === 0) {
      mintLog(reqId, wallet, "reject", { reason: "empty_after_sanitize" });
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
      mintLog(reqId, wallet, "reject", { reason: "image_decode_failed" });
      return NextResponse.json({ error: "Image data URL could not be decoded" }, { status: 400 });
    }
    // Reject images that are suspiciously large or empty. Base PFP is ~200 KB.
    if (imageBuffer.length === 0 || imageBuffer.length > 5 * 1024 * 1024) {
      mintLog(reqId, wallet, "reject", { reason: "bad_image_size", bytes: imageBuffer.length });
      return NextResponse.json({ error: "Image payload invalid (empty or >5 MB)" }, { status: 400 });
    }

    // --- Rate limit ---
    const rateCheck = checkRateLimit(wallet);
    if (!rateCheck.allowed) {
      const retryAfterSec = Math.ceil((rateCheck.retryAfterMs || 0) / 1000);
      mintLog(reqId, wallet, "reject", { reason: "rate_limit", retryAfterSec });
      return NextResponse.json(
        {
          error: `Rate limit exceeded. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.`,
          retryAfterSec,
        },
        { status: 429 },
      );
    }
    mintLog(reqId, wallet, "preflight", { elapsedMs: Date.now() - t0 });

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
      mintLog(reqId, wallet, "error", { step: "read_mintDeadline", msg: (err as Error).message });
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "Could not verify mint deadline. Try again shortly." }, { status: 503 });
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    // 60s grace: don't start a mint we know we can't confirm before the deadline.
    if (nowSec + 60n >= mintDeadline) {
      mintLog(reqId, wallet, "reject", { reason: "deadline_passed" });
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "The CLAWD PFP minting window has closed." }, { status: 410 });
    }

    // --- Preflight: relayer balance ---
    let relayerAccount;
    try {
      relayerAccount = getRelayerAccount();
    } catch (err) {
      mintLog(reqId, wallet, "error", { step: "relayer_init", msg: (err as Error).message });
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "Minting temporarily unavailable (relayer not configured)." }, { status: 503 });
    }
    const relayerBalance = await publicClient.getBalance({ address: relayerAccount.address });
    if (relayerBalance < MIN_RELAYER_ETH) {
      mintLog(reqId, wallet, "reject", { reason: "relayer_low_balance", balanceWei: relayerBalance });
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
      mintLog(reqId, wallet, "reject", { reason: "insufficient_cv", have: balance.balance, need: MINT_CV_COST });
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

    // --- Verify image provenance BEFORE charging CV. ---
    // The image must have come from our /api/generate for this wallet within
    // the last 10 minutes — otherwise an attacker could submit any image and
    // we'd charge CV + mint it on-chain.
    if (
      !provenance ||
      typeof provenance !== "object" ||
      typeof provenance.imageSha256 !== "string" ||
      typeof provenance.wallet !== "string" ||
      typeof provenance.expiry !== "number" ||
      typeof provenance.hmac !== "string"
    ) {
      mintLog(reqId, wallet, "reject", { reason: "missing_provenance" });
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "missing provenance" }, { status: 400 });
    }
    if (provenance.wallet.toLowerCase() !== wallet.toLowerCase()) {
      mintLog(reqId, wallet, "reject", { reason: "provenance_wallet_mismatch" });
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "provenance wallet mismatch" }, { status: 400 });
    }
    if (provenance.expiry <= Math.floor(Date.now() / 1000)) {
      mintLog(reqId, wallet, "reject", { reason: "provenance_expired" });
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "provenance expired" }, { status: 400 });
    }
    const incomingImageSha = sha256ImageBase64(imageDataUrl);
    if (incomingImageSha !== provenance.imageSha256) {
      mintLog(reqId, wallet, "reject", { reason: "image_sha_mismatch" });
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "image does not match provenance" }, { status: 400 });
    }
    const verify = verifyImageProvenance({
      imageBase64: imageDataUrl,
      wallet: provenance.wallet,
      expiry: provenance.expiry,
      hmac: provenance.hmac,
    });
    if (!verify.ok) {
      mintLog(reqId, wallet, "reject", { reason: "bad_provenance_hmac" });
      decrementRateLimit(wallet);
      return NextResponse.json({ error: "invalid provenance signature" }, { status: 400 });
    }

    // --- Pin image to BGIPFS (BEFORE charging CV) ---
    // We intentionally pin & simulate before the CV charge so a transient
    // BGIPFS blip or a revert doesn't burn the user's CV. The generate flow
    // already cost CV to produce this image (gated by the provenance HMAC
    // expiring in 10 min), so a pin-only request can't be cheaper spam than
    // the existing generate cost.
    let imageCid: string;
    try {
      const upload = await bgipfsAddBytes(
        imageBuffer,
        `clawd-pfp.${imageContentType.split("/")[1] || "png"}`,
        imageContentType,
      );
      imageCid = upload.cid;
    } catch (err) {
      mintLog(reqId, wallet, "ipfs_image_failed", { msg: (err as Error).message });
      decrementRateLimit(wallet);
      return NextResponse.json(
        {
          error: `Image pinning failed: ${(err as Error).message}. No CV was charged — please try again in a moment.`,
        },
        { status: 502 },
      );
    }
    mintLog(reqId, wallet, "image_pinned", { cid: imageCid, bytes: imageBuffer.length, elapsedMs: Date.now() - t0 });

    // --- Build + pin metadata JSON (still before CV charge) ---
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
      mintLog(reqId, wallet, "ipfs_metadata_failed", { msg: (err as Error).message });
      decrementRateLimit(wallet);
      return NextResponse.json(
        {
          error: `Metadata pinning failed: ${(err as Error).message}. No CV was charged — please try again in a moment.`,
        },
        { status: 502 },
      );
    }
    const metadataURI = bgipfsGatewayUrl(metadataCid);
    mintLog(reqId, wallet, "metadata_pinned", { cid: metadataCid, elapsedMs: Date.now() - t0 });

    // --- Simulate the mint (still before CV charge, catches on-chain reverts cheap) ---
    try {
      await publicClient.simulateContract({
        account: relayerAccount.address,
        address: CLAWDPFP_ADDRESS,
        abi: CLAWDPFP_ABI,
        functionName: "mint",
        args: [wallet as `0x${string}`, metadataURI],
      });
    } catch (err) {
      mintLog(reqId, wallet, "simulate_reverted", { msg: (err as Error).message });
      decrementRateLimit(wallet);
      return NextResponse.json(
        {
          error: `Mint simulation failed: ${(err as Error).message}. No CV was charged — please try again shortly.`,
        },
        { status: 502 },
      );
    }
    mintLog(reqId, wallet, "simulated", { elapsedMs: Date.now() - t0 });

    // --- Charge CV (tightly coupled to tx submission now) ---
    // We intentionally DO NOT pre-verify the signature ourselves. ERC-1271
    // smart wallets (Coinbase Smart Wallet, many Safe configs) mix chain_id
    // into their signing domain, so a sig produced while the dapp is on
    // mainnet will only verify on mainnet, while a sig produced on Base
    // only verifies on Base. We can't reliably know which chain the user's
    // wallet is bound to, so we let larv.ai be the authority and surface
    // their sig-error verbatim with code: bad_signature below.
    mintLog(reqId, wallet, "charging_cv", { elapsedMs: Date.now() - t0 });
    const charge = await spendCv({ wallet, amount: MINT_CV_COST, signature });
    if (!charge.ok) {
      // Flag signature-related errors explicitly so the frontend can clear
      // the stale cached signature and prompt the user to re-sign.
      const errText = charge.error || "unknown";
      const isSigError = /signature|invalid.*sig|sig.*invalid|sig.*length/i.test(errText);
      mintLog(reqId, wallet, "cv_charge_failed", {
        status: charge.status,
        err: errText,
        isSigError,
        sigLen: signature.length,
      });
      decrementRateLimit(wallet);
      return NextResponse.json(
        {
          error: `CV charge failed: ${errText}`,
          code: isSigError ? "bad_signature" : undefined,
        },
        { status: charge.status === 402 ? 402 : 502 },
      );
    }
    mintLog(reqId, wallet, "cv_charged", { newBalance: charge.newBalance, elapsedMs: Date.now() - t0 });

    // From this point on we've taken the user's CV. Any failure needs to be
    // logged so it can be reconciled manually (larv.ai doesn't support
    // programmatic refunds). Should only fire now for tx-submission or on-
    // chain-revert failures — pin/sim failures return early above.
    const logCvCharged = (detail: string) =>
      console.error(
        `[MINT_RECONCILE] wallet=${wallet} charged=${MINT_CV_COST} CV but ${detail}. Manual refund required.`,
      );

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
      mintLog(reqId, wallet, "write_failed", { msg: (err as Error).message });
      logCvCharged(`mint write failed: ${(err as Error).message}`);
      return NextResponse.json(
        {
          error: "Mint transaction failed to submit. Your CV has been charged — please contact support.",
          reconcile: { wallet, amount: MINT_CV_COST, imageCid, metadataCid },
        },
        { status: 502 },
      );
    }
    mintLog(reqId, wallet, "broadcast", { txHash, elapsedMs: Date.now() - t0 });

    // --- Wait for receipt + parse tokenId ---
    // Leave enough headroom for the 120s maxDuration: preflight + pins + sim
    // already consumed ~5-20s. Give viem 60s then do one more manual poll.
    const waitStartedAt = Date.now();
    let tokenIdFromReceipt: bigint | null = null;
    let receiptStatus: "success" | "reverted" | "pending" = "pending";
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status === "success") {
        tokenIdFromReceipt = parseTokenIdFromReceiptLogs(receipt.logs);
        receiptStatus = "success";
        mintLog(reqId, wallet, "confirmed", {
          txHash,
          tokenId: tokenIdFromReceipt,
          blockNumber: receipt.blockNumber,
          waitMs: Date.now() - waitStartedAt,
        });
      } else {
        receiptStatus = "reverted";
        mintLog(reqId, wallet, "reverted", { txHash, blockNumber: receipt.blockNumber });
        logCvCharged(`mint tx reverted on-chain (${txHash})`);
        return NextResponse.json(
          {
            error: "Mint transaction reverted on-chain. Your CV has been charged — please contact support.",
            code: "tx_reverted",
            txHash,
            reconcile: { wallet, amount: MINT_CV_COST, imageCid, metadataCid, txHash },
          },
          { status: 502 },
        );
      }
    } catch (err) {
      // Timed out waiting. One more direct poll — the tx may have landed right
      // as we were giving up. If it still isn't mined, return 202 pending and
      // let the frontend show an Etherscan link instead of claiming success.
      mintLog(reqId, wallet, "wait_timeout", {
        txHash,
        msg: (err as Error).message,
        waitMs: Date.now() - waitStartedAt,
      });
      try {
        const late = await publicClient.getTransactionReceipt({ hash: txHash });
        if (late && late.status === "success") {
          tokenIdFromReceipt = parseTokenIdFromReceiptLogs(late.logs);
          receiptStatus = "success";
          mintLog(reqId, wallet, "confirmed_late", {
            txHash,
            tokenId: tokenIdFromReceipt,
            blockNumber: late.blockNumber,
          });
        } else if (late && late.status === "reverted") {
          receiptStatus = "reverted";
          mintLog(reqId, wallet, "reverted_late", { txHash, blockNumber: late.blockNumber });
          logCvCharged(`mint tx reverted on-chain (${txHash})`);
          return NextResponse.json(
            {
              error: "Mint transaction reverted on-chain. Your CV has been charged — please contact support.",
              code: "tx_reverted",
              txHash,
              reconcile: { wallet, amount: MINT_CV_COST, imageCid, metadataCid, txHash },
            },
            { status: 502 },
          );
        }
      } catch {
        // getTransactionReceipt throws when tx is not yet mined — that's fine,
        // we fall through to the pending response below.
      }
    }

    // Receipt timed out AND the post-timeout poll found nothing: tx is still
    // pending (or was dropped from mempool). Return 202 so the frontend can
    // show an Etherscan link instead of falsely reporting success with a
    // tokenId we can't actually confirm is correct.
    if (receiptStatus === "pending") {
      mintLog(reqId, wallet, "return_pending", { txHash, totalMs: Date.now() - t0 });
      logCvCharged(`mint tx pending after wait (${txHash}) — may still confirm or have been dropped`);
      return NextResponse.json(
        {
          error:
            "Your transaction was broadcast but hasn't confirmed yet. Check Etherscan below — if it doesn't confirm in a few minutes, please contact support.",
          code: "tx_pending",
          txHash,
          imageCid,
          metadataCid,
          imageUrl: imageGatewayUrl,
          reconcile: { wallet, amount: MINT_CV_COST, imageCid, metadataCid, txHash },
        },
        { status: 202 },
      );
    }

    const finalTokenId =
      tokenIdFromReceipt !== null
        ? Number(tokenIdFromReceipt)
        : predictedTokenId !== null
          ? Number(predictedTokenId)
          : null;

    mintLog(reqId, wallet, "done", { txHash, tokenId: finalTokenId, totalMs: Date.now() - t0 });
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
    mintLog(reqId, wallet, "unhandled_error", { msg: (error as Error).message, totalMs: Date.now() - t0 });
    console.error("Mint API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
