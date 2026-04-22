/**
 * Server-only helpers for LeftClaw PFP API, larv.ai CV, and BGIPFS pinning.
 * This module must NEVER be imported from a client component — it reads
 * server-only env vars (CV_SPEND_SECRET, BGIPFS_TOKEN, RELAYER_PRIVATE_KEY).
 */
// NOTE: this module is server-only. It reads secrets like CV_SPEND_SECRET,
// BGIPFS_TOKEN, and RELAYER_PRIVATE_KEY — do NOT import it from a
// "use client" file. The sibling /app/api/*/route.ts handlers are the only
// intended callers.
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { type Address, type Hex, createPublicClient, createWalletClient, decodeEventLog, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

export const PFP_API_URL = "https://leftclaw.services/api/pfp/generate-cv";
export const PFP_COST_URL = "https://leftclaw.services/api/pfp/cost";
export const LARV_BALANCE_URL = "https://larv.ai/api/cv/balance";
export const LARV_SPEND_URL = "https://larv.ai/api/cv/spend";
export const BGIPFS_ADD_URL = "https://upload.bgipfs.com/api/v0/add?cid-version=1";
export const BGIPFS_GATEWAY_TEMPLATE = "https://{cid}.ipfs.community.bgipfs.com/";

export const MINT_CV_COST = 5_000_000;
export const MIN_RELAYER_ETH = parseEther("0.001");
export const CLAWDPFP_ADDRESS: Address = "0xB5741B033c45330A34952436a34b1B25a208Af10";

export function getAlchemyRpcUrl(): string {
  const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (!key) throw new Error("NEXT_PUBLIC_ALCHEMY_API_KEY is not set");
  return `https://eth-mainnet.g.alchemy.com/v2/${key}`;
}

export function getPublicClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(getAlchemyRpcUrl()),
  });
}

export function getRelayerAccount() {
  const raw = process.env.RELAYER_PRIVATE_KEY;
  if (!raw) throw new Error("RELAYER_PRIVATE_KEY is not set");
  const pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  return privateKeyToAccount(pk);
}

export function getWalletClient() {
  return createWalletClient({
    account: getRelayerAccount(),
    chain: mainnet,
    transport: http(getAlchemyRpcUrl()),
  });
}

// -------------------- LeftClaw pricing --------------------

// Upstream serves Cache-Control: public, max-age=30. We mirror that here so
// bursts of requests on the same lambda instance don't each make an external
// round-trip, while still letting the price update within ~30s.
const COST_CACHE_TTL_MS = 30_000;
let cachedCost: { value: number; fetchedAt: number } | null = null;

export type PfpCostResponse = {
  version: number;
  generateCvCost: number;
  cvDivisor?: number;
  highestCVBalance?: number;
  priceUsd?: number;
  formula?: string;
};

/**
 * Fetches the current LeftClaw generate-CV cost. Throws on non-200 or on a
 * malformed payload — callers should treat failure as "pricing unavailable"
 * rather than silently falling back to a stale constant.
 */
export async function fetchGenerateCvCost(): Promise<number> {
  const now = Date.now();
  if (cachedCost && now - cachedCost.fetchedAt < COST_CACHE_TTL_MS) {
    return cachedCost.value;
  }
  const res = await fetch(PFP_COST_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`PFP cost endpoint returned HTTP ${res.status}`);
  }
  const data = (await res.json().catch(() => ({}))) as Partial<PfpCostResponse>;
  const cost = typeof data.generateCvCost === "number" ? data.generateCvCost : NaN;
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error("PFP cost endpoint returned invalid generateCvCost");
  }
  cachedCost = { value: cost, fetchedAt: now };
  return cost;
}

// -------------------- larv.ai CV --------------------

export type CvBalance = {
  balance: number;
  found: boolean;
};

export async function getCvBalance(wallet: string): Promise<CvBalance> {
  const res = await fetch(`${LARV_BALANCE_URL}?address=${wallet}`, {
    method: "GET",
    cache: "no-store",
  });
  // 404 / wallet-not-found -> treat as zero balance.
  const data = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    balance?: number | string;
    error?: string;
  };
  if (data?.success === false) {
    // "wallet not found" = no CV account yet = effectively 0
    return { balance: 0, found: false };
  }
  const bal = typeof data.balance === "string" ? Number(data.balance) : (data.balance ?? 0);
  return { balance: Number.isFinite(bal) ? bal : 0, found: true };
}

export type CvSpendResult = {
  ok: boolean;
  status: number;
  newBalance?: number;
  error?: string;
};

/**
 * Charges the user's CV wallet the given amount. The user's `signature` over
 * "larv.ai CV Spend" authorizes the spend; the CV_SPEND_SECRET proves this
 * API route is authorized to request the charge.
 */
export async function spendCv(params: { wallet: string; amount: number; signature: string }): Promise<CvSpendResult> {
  const secret = process.env.CV_SPEND_SECRET;
  if (!secret) return { ok: false, status: 500, error: "CV_SPEND_SECRET not configured" };

  const res = await fetch(LARV_SPEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet: params.wallet,
      amount: params.amount,
      secret,
      signature: params.signature,
    }),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    balance?: number | string;
    newBalance?: number | string;
    error?: string;
  };
  if (!res.ok || data?.success === false) {
    return {
      ok: false,
      status: res.status,
      error: data?.error || `CV spend failed (HTTP ${res.status})`,
    };
  }
  const nb = data.newBalance ?? data.balance;
  const newBalance = typeof nb === "string" ? Number(nb) : nb;
  return {
    ok: true,
    status: res.status,
    newBalance: Number.isFinite(newBalance as number) ? (newBalance as number) : undefined,
  };
}

// -------------------- LeftClaw PFP API --------------------

export type PfpGenerateResult =
  | {
      ok: true;
      image: string; // data:image/png;base64,...
      prompt: string;
      cvSpent?: number;
      newBalance?: number | string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      currentBalance?: number;
      required?: number;
    };

export async function generatePfp(params: {
  wallet: string;
  prompt: string;
  signature: string;
}): Promise<PfpGenerateResult> {
  const res = await fetch(PFP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet: params.wallet,
      prompt: params.prompt,
      signature: params.signature,
    }),
    cache: "no-store",
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: (data.error as string) || `PFP API error (HTTP ${res.status})`,
      currentBalance: typeof data.currentBalance === "number" ? (data.currentBalance as number) : undefined,
      required: typeof data.required === "number" ? (data.required as number) : undefined,
    };
  }

  const image = data.image as string | undefined;
  if (!image || !image.startsWith("data:image/")) {
    return {
      ok: false,
      status: 502,
      error: "PFP API returned invalid image payload",
    };
  }
  return {
    ok: true,
    image,
    prompt: (data.prompt as string) || params.prompt,
    cvSpent: typeof data.cvSpent === "number" ? (data.cvSpent as number) : undefined,
    newBalance: data.newBalance as number | string | undefined,
  };
}

// -------------------- BGIPFS --------------------

export type BgipfsUploadResult = { cid: string; size: number; name: string };

/**
 * Uploads raw bytes to BGIPFS and returns a CIDv1 string. Uses the go-ipfs
 * compatible /api/v0/add endpoint with `cid-version=1` (required for the
 * subdomain gateway at community.bgipfs.com).
 */
export async function bgipfsAddBytes(
  bytes: Uint8Array | Buffer,
  filename: string,
  contentType: string,
): Promise<BgipfsUploadResult> {
  const token = process.env.BGIPFS_TOKEN;
  if (!token) throw new Error("BGIPFS_TOKEN not configured");

  const form = new FormData();
  // The go-ipfs /api/v0/add endpoint expects the field name `file`.
  form.append("file", new Blob([bytes], { type: contentType }), filename);

  const res = await fetch(BGIPFS_ADD_URL, {
    method: "POST",
    headers: { "X-API-Key": token },
    body: form,
    cache: "no-store",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`BGIPFS upload failed (HTTP ${res.status}): ${errText.slice(0, 200)}`);
  }

  // go-ipfs /api/v0/add can return NDJSON when uploading multiple files;
  // for a single file it's one JSON object, but be defensive.
  const text = await res.text();
  const lastLine = text.trim().split("\n").filter(Boolean).pop() || "{}";
  const parsed = JSON.parse(lastLine) as { Hash?: string; Size?: string | number; Name?: string };
  if (!parsed.Hash) throw new Error("BGIPFS upload did not return a CID");
  const size = typeof parsed.Size === "string" ? Number(parsed.Size) : (parsed.Size ?? 0);
  return { cid: parsed.Hash, size, name: parsed.Name || filename };
}

export async function bgipfsAddJson(obj: unknown, filename: string): Promise<BgipfsUploadResult> {
  const bytes = Buffer.from(JSON.stringify(obj), "utf8");
  return bgipfsAddBytes(bytes, filename, "application/json");
}

export function bgipfsGatewayUrl(cid: string): string {
  return BGIPFS_GATEWAY_TEMPLATE.replace("{cid}", cid);
}

// -------------------- ClawdPFP contract --------------------

// Minimal ABI subset used by the mint route. Kept local to avoid importing
// the client-side `deployedContracts.ts` (which is scoped to ~~ alias).
export const CLAWDPFP_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "_tokenURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "mintDeadline",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "minter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "PFPMinted",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenURI", type: "string", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
    anonymous: false,
  },
] as const;

// Mainnet block where ClawdPFP was deployed — keeps the getLogs scan tight.
export const CLAWDPFP_DEPLOY_BLOCK = 24893757n;

// -------------------- Gallery listing --------------------

export type PfpListEntry = {
  id: number;
  image: string | null;
  minter: string;
  tokenUri: string;
  name: string | null;
  description: string | null;
};

// Per-lambda in-memory cache. Cold starts re-populate from chain + IPFS, but
// within a warm instance we only process blocks we haven't scanned yet.
const pfpEntryCache = new Map<number, PfpListEntry>();
let lastScannedBlock: bigint | null = null;
let refreshInFlight: Promise<void> | null = null;

type ResolvedMetadata = {
  image: string | null;
  name: string | null;
  description: string | null;
};

async function resolveMetadata(tokenUri: string): Promise<ResolvedMetadata> {
  try {
    const res = await fetch(tokenUri, { cache: "force-cache" });
    if (!res.ok) return { image: null, name: null, description: null };
    const json = (await res.json()) as { image?: unknown; name?: unknown; description?: unknown };
    return {
      image: typeof json.image === "string" ? json.image : null,
      name: typeof json.name === "string" ? json.name : null,
      description: typeof json.description === "string" ? json.description : null,
    };
  } catch {
    return { image: null, name: null, description: null };
  }
}

async function refreshPfpList(): Promise<void> {
  const client = getPublicClient();
  const currentBlock = await client.getBlockNumber();
  const fromBlock = lastScannedBlock !== null ? lastScannedBlock + 1n : CLAWDPFP_DEPLOY_BLOCK;
  if (fromBlock > currentBlock) return;

  const logs = await client.getLogs({
    address: CLAWDPFP_ADDRESS,
    event: {
      type: "event",
      name: "PFPMinted",
      inputs: [
        { name: "tokenId", type: "uint256", indexed: true },
        { name: "to", type: "address", indexed: true },
        { name: "tokenURI", type: "string", indexed: false },
      ],
    },
    fromBlock,
    toBlock: currentBlock,
  });

  await Promise.all(
    logs.map(async log => {
      const tokenId = Number(log.args.tokenId);
      const minter = (log.args.to ?? "") as string;
      const tokenUri = (log.args.tokenURI ?? "") as string;
      const metadata = tokenUri ? await resolveMetadata(tokenUri) : { image: null, name: null, description: null };
      pfpEntryCache.set(tokenId, { id: tokenId, minter, tokenUri, ...metadata });
    }),
  );

  lastScannedBlock = currentBlock;
}

/**
 * Returns every ClawdPFP mint as a flat list, newest first. Designed for
 * public consumption by bots / aggregators — resolves tokenURI metadata to
 * include the image URL directly so callers don't need to fetch IPFS.
 */
export async function listAllPfps(): Promise<PfpListEntry[]> {
  // Coalesce concurrent requests onto a single refresh so a cold-start burst
  // doesn't fan out 150 IPFS fetches × N callers.
  if (!refreshInFlight) {
    refreshInFlight = refreshPfpList().finally(() => {
      refreshInFlight = null;
    });
  }
  await refreshInFlight;
  return [...pfpEntryCache.values()].sort((a, b) => b.id - a.id);
}

// -------------------- Image provenance (HMAC) --------------------

export const IMAGE_PROVENANCE_TTL_SEC = 10 * 60; // 10 minutes

export type ImageProvenance = {
  imageSha256: string;
  wallet: string;
  expiry: number;
  hmac: string;
};

function getImageProvenanceSecret(): string {
  const secret = process.env.IMAGE_PROVENANCE_SECRET;
  if (!secret) throw new Error("IMAGE_PROVENANCE_SECRET is not set");
  return secret;
}

/**
 * Hashes the raw image bytes (the base64 payload of a `data:image/...` URL,
 * decoded) with SHA-256 and returns the hex digest. Hashing the bytes — not
 * the data-URL string — avoids false mismatches from whitespace / MIME
 * variations between generate and mint. Accepts either a bare base64 string
 * or a full `data:image/...;base64,<payload>` URL.
 */
export function sha256ImageBase64(imageBase64OrDataUrl: string): string {
  const comma = imageBase64OrDataUrl.indexOf(",");
  const base64 =
    imageBase64OrDataUrl.startsWith("data:") && comma >= 0
      ? imageBase64OrDataUrl.slice(comma + 1)
      : imageBase64OrDataUrl;
  const bytes = Buffer.from(base64, "base64");
  return createHash("sha256").update(bytes).digest("hex");
}

function provenanceMessage(imageSha256Hex: string, wallet: string, expiry: number): string {
  return `${imageSha256Hex}.${wallet.toLowerCase()}.${expiry}`;
}

/**
 * Signs a short-lived HMAC over (image-hash, wallet, expiry) so that /api/mint
 * can verify an image was actually produced by /api/generate for that wallet.
 */
export function signImageProvenance(params: { imageBase64: string; wallet: string }): ImageProvenance {
  const secret = getImageProvenanceSecret();
  const imageSha256 = sha256ImageBase64(params.imageBase64);
  const wallet = params.wallet.toLowerCase();
  const expiry = Math.floor(Date.now() / 1000) + IMAGE_PROVENANCE_TTL_SEC;
  const hmac = createHmac("sha256", secret)
    .update(provenanceMessage(imageSha256, wallet, expiry))
    .digest("hex");
  return { imageSha256, wallet, expiry, hmac };
}

export type ImageProvenanceVerifyResult = { ok: true } | { ok: false; error: string };

/**
 * Verifies a provenance token returned from signImageProvenance. Caller must
 * still separately compare the claimed `wallet` to the request's wallet and
 * the claimed `imageSha256` to a hash of the incoming image — see the
 * ordered checks in /app/api/mint/route.ts.
 */
export function verifyImageProvenance(params: {
  imageBase64: string;
  wallet: string;
  expiry: number;
  hmac: string;
}): ImageProvenanceVerifyResult {
  const secret = getImageProvenanceSecret();
  const imageSha256 = sha256ImageBase64(params.imageBase64);
  const expected = createHmac("sha256", secret)
    .update(provenanceMessage(imageSha256, params.wallet.toLowerCase(), params.expiry))
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(params.hmac, "hex");
  } catch {
    return { ok: false, error: "invalid provenance signature" };
  }
  if (provided.length !== expected.length) {
    return { ok: false, error: "invalid provenance signature" };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, error: "invalid provenance signature" };
  }
  return { ok: true };
}

// -------------------- Misc --------------------

export function parseImageDataUrl(dataUrl: string): { buffer: Buffer; contentType: string } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Invalid data URL");
  const contentType = match[1];
  const isBase64 = Boolean(match[2]);
  const payload = match[3];
  const buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  return { buffer, contentType };
}

type RawLog = { address: string; topics: readonly string[]; data: string };

export function parseTokenIdFromReceiptLogs(logs: readonly RawLog[]): bigint | null {
  // Prefer our custom PFPMinted event, fall back to Transfer.
  const events = [
    { name: "PFPMinted" as const, key: "tokenId" as const },
    { name: "Transfer" as const, key: "tokenId" as const },
  ];
  for (const log of logs) {
    if (log.address.toLowerCase() !== CLAWDPFP_ADDRESS.toLowerCase()) continue;
    for (const evt of events) {
      try {
        const decoded = decodeEventLog({
          abi: CLAWDPFP_ABI,
          eventName: evt.name,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          data: log.data as `0x${string}`,
        });
        const args = decoded.args as Record<string, unknown>;
        const raw = args[evt.key];
        if (typeof raw === "bigint") return raw;
      } catch {
        // try next
      }
    }
  }
  return null;
}
