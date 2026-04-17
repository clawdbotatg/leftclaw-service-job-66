import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { isAddress } from "viem";
import {
  CLAWDPFP_ABI,
  CLAWDPFP_ADDRESS,
  GENERATE_CV_COST,
  generatePfp,
  getCvBalance,
  getPublicClient,
  signImageProvenance,
} from "~~/lib/server/pfpApi";

function genLog(reqId: string, wallet: string, stage: string, extra: Record<string, unknown> = {}) {
  const parts = [`[GENERATE]`, `reqId=${reqId}`, `wallet=${wallet}`, `stage=${stage}`];
  for (const [k, v] of Object.entries(extra)) {
    const val = typeof v === "bigint" ? v.toString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${val}`);
  }
  console.log(parts.join(" "));
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-memory rate limiting (resets on server restart / per lambda instance).
// For a stronger guarantee we'd back this with Redis; per-route in-memory
// matches the job spec and is fine for the expected traffic.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
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

export async function POST(request: NextRequest) {
  const reqId = randomBytes(4).toString("hex");
  const t0 = Date.now();
  let wallet = "unknown";
  try {
    const body = (await request.json().catch(() => ({}))) as {
      wallet?: string;
      prompt?: string;
      signature?: string;
    };
    const { wallet: bodyWallet, prompt, signature } = body;
    wallet = bodyWallet || "unknown";

    // --- Validate inputs ---
    if (!bodyWallet || !isAddress(bodyWallet)) {
      genLog(reqId, wallet, "reject", { reason: "invalid_wallet" });
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }
    if (!prompt || typeof prompt !== "string" || prompt.length === 0 || prompt.length > 280) {
      genLog(reqId, wallet, "reject", { reason: "bad_prompt", len: prompt?.length });
      return NextResponse.json({ error: "Prompt must be 1-280 characters" }, { status: 400 });
    }
    if (!signature || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      genLog(reqId, wallet, "reject", { reason: "bad_signature_format", len: signature?.length });
      return NextResponse.json({ error: "Signature is required and must be hex" }, { status: 400 });
    }
    if (signature.length !== 132) {
      genLog(reqId, wallet, "warn_nonstandard_sig", { sigLen: signature.length });
    }
    genLog(reqId, wallet, "start", { promptLen: prompt.length, sigLen: signature.length });

    const sanitizedPrompt = prompt.replace(/<[^>]*>/g, "").trim();
    if (sanitizedPrompt.length === 0) {
      genLog(reqId, wallet, "reject", { reason: "empty_after_sanitize" });
      return NextResponse.json({ error: "Prompt cannot be empty after sanitization" }, { status: 400 });
    }

    // --- Rate limit ---
    const rateCheck = checkRateLimit(wallet);
    if (!rateCheck.allowed) {
      const retryAfterSec = Math.ceil((rateCheck.retryAfterMs || 0) / 1000);
      genLog(reqId, wallet, "reject", { reason: "rate_limit", retryAfterSec });
      return NextResponse.json(
        {
          error: `Rate limit exceeded. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.`,
          retryAfterSec,
        },
        { status: 429 },
      );
    }

    // --- Mint deadline check (read from contract) ---
    // Generation is tied to minting: once the window closes, new PFPs serve
    // no purpose (they can't be minted). We reject early to avoid charging CV.
    try {
      const publicClient = getPublicClient();
      const mintDeadline = await publicClient.readContract({
        address: CLAWDPFP_ADDRESS,
        abi: CLAWDPFP_ABI,
        functionName: "mintDeadline",
      });
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (nowSec > (mintDeadline as bigint)) {
        genLog(reqId, wallet, "reject", { reason: "deadline_passed" });
        return NextResponse.json({ error: "The CLAWD PFP minting window has closed." }, { status: 410 });
      }
    } catch (err) {
      genLog(reqId, wallet, "warn", { step: "read_mintDeadline", msg: (err as Error).message });
      // Don't block the request on RPC hiccups — the PFP API will still work
      // and the mint path independently re-checks the deadline.
    }

    // --- Preflight: CV balance ---
    const balance = await getCvBalance(wallet);
    if (balance.balance < GENERATE_CV_COST) {
      genLog(reqId, wallet, "reject", { reason: "insufficient_cv", have: balance.balance, need: GENERATE_CV_COST });
      return NextResponse.json(
        {
          error: `Insufficient CV. Need ${GENERATE_CV_COST.toLocaleString()} CV, have ${balance.balance.toLocaleString()}.`,
          currentBalance: balance.balance,
          required: GENERATE_CV_COST,
        },
        { status: 402 },
      );
    }

    // --- Forward to LeftClaw PFP API ---
    // The upstream API charges the user's CV directly using the signature —
    // we do NOT call /api/cv/spend here or we'd double-charge.
    genLog(reqId, wallet, "forwarding_upstream", { elapsedMs: Date.now() - t0 });
    const result = await generatePfp({
      wallet,
      prompt: sanitizedPrompt,
      signature,
    });

    if (!result.ok) {
      // Refund the rate-limit token so the user doesn't burn a retry on
      // upstream failure.
      const entry = rateLimitMap.get(wallet.toLowerCase());
      if (entry && entry.count > 0) entry.count -= 1;

      const isSigError = /signature|invalid.*sig|sig.*invalid|sig.*length/i.test(result.error);
      genLog(reqId, wallet, "upstream_failed", {
        status: result.status,
        err: result.error,
        isSigError,
        sigLen: signature.length,
      });

      const status = result.status >= 400 && result.status < 600 ? result.status : 502;
      return NextResponse.json(
        {
          error: result.error,
          code: isSigError ? "bad_signature" : undefined,
          currentBalance: result.currentBalance,
          required: result.required,
        },
        { status },
      );
    }

    // Sign the returned image so /api/mint can verify it actually came from
    // this route (and was generated for this wallet) before spending CV.
    let provenance;
    try {
      provenance = signImageProvenance({ imageBase64: result.image, wallet });
    } catch (err) {
      genLog(reqId, wallet, "provenance_sign_failed", { msg: (err as Error).message });
      return NextResponse.json({ error: "Image provenance signing failed" }, { status: 500 });
    }

    genLog(reqId, wallet, "done", { cvSpent: result.cvSpent, totalMs: Date.now() - t0 });
    return NextResponse.json({
      image: result.image,
      prompt: result.prompt,
      cvSpent: result.cvSpent,
      newBalance: result.newBalance,
      provenance,
    });
  } catch (error) {
    genLog(reqId, wallet, "unhandled_error", { msg: (error as Error).message, totalMs: Date.now() - t0 });
    console.error("Generate API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
