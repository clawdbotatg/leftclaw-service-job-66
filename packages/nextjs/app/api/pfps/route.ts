import { NextResponse } from "next/server";
import { listAllPfps } from "~~/lib/server/pfpApi";

export const runtime = "nodejs";
// Not force-dynamic — we want Vercel's data cache to respect the headers
// below so bot traffic doesn't keep re-scanning IPFS.
export const revalidate = 60;

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
