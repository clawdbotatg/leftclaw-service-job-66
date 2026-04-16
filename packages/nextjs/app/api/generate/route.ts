import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import {
  CLAWDPFP_ABI,
  CLAWDPFP_ADDRESS,
  GENERATE_CV_COST,
  generatePfp,
  getCvBalance,
  getPublicClient,
} from "~~/lib/server/pfpApi";

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
  try {
    const body = (await request.json().catch(() => ({}))) as {
      wallet?: string;
      prompt?: string;
      signature?: string;
    };
    const { wallet, prompt, signature } = body;

    // --- Validate inputs ---
    if (!wallet || !isAddress(wallet)) {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
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
        return NextResponse.json({ error: "The CLAWD PFP minting window has closed." }, { status: 410 });
      }
    } catch (err) {
      console.error("mintDeadline read failed:", err);
      // Don't block the request on RPC hiccups — the PFP API will still work
      // and the mint path independently re-checks the deadline.
    }

    // --- Preflight: CV balance ---
    const balance = await getCvBalance(wallet);
    if (balance.balance < GENERATE_CV_COST) {
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

      const status = result.status >= 400 && result.status < 600 ? result.status : 502;
      return NextResponse.json(
        {
          error: result.error,
          currentBalance: result.currentBalance,
          required: result.required,
        },
        { status },
      );
    }

    return NextResponse.json({
      image: result.image,
      prompt: result.prompt,
      cvSpent: result.cvSpent,
      newBalance: result.newBalance,
    });
  } catch (error) {
    console.error("Generate API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
