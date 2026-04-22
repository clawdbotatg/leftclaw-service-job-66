import { NextResponse } from "next/server";
import { listAllPfps } from "~~/lib/server/pfpApi";

export const runtime = "nodejs";
// Must be dynamic — a revalidate window causes `next build` to try to
// pre-render this route at build time, which kicks off a full chain scan
// + N × IPFS fetches and exceeds the 60s Vercel build timeout. Bot/edge
// caching is still handled by the Cache-Control header below.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const entries = await listAllPfps();
    return NextResponse.json(entries, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
