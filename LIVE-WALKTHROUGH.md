# Live Walk-Through — Stage 10

Verification of the deployed CLAWD PFP dApp on Ethereum mainnet.

## Deployment under test

- **Contract:** `0xB5741B033c45330A34952436a34b1B25a208Af10` on chainId 1
- **Original CID at walkthrough start:** `bafybeihhvt5ub6lmwnfnl6s3fkmhasix7zxezlq6n45zgy7xl4asg24jyu`
- **Updated CID after OG fix:** `bafybeihdb3xry4xr3zs575zybnciu7sjv5bdyu6n333xuyklozbwq7z3xa`
- **Current live frontend:** <https://bafybeihdb3xry4xr3zs575zybnciu7sjv5bdyu6n333xuyklozbwq7z3xa.ipfs.community.bgipfs.com/>
- **Etherscan:** <https://etherscan.io/address/0xB5741B033c45330A34952436a34b1B25a208Af10> (verified)

## On-chain state reads (via Alchemy mainnet RPC)

| Call | Expected | Actual | Result |
|---|---|---|---|
| `minter()` | `0x5430757ee25f25D11987B206C1789d394a779200` | `0x5430757ee25f25D11987B206C1789d394a779200` | PASS |
| `mintDeadline()` | future Unix timestamp near 2026-04-23 | `1776963779` | PASS |
| `ownerOf(0)` | reverts (no mints yet) | `ERC721NonexistentToken(0)` | PASS |
| Minter ETH balance | > 0 (gas bootstrapped) | `0.00941 ETH` (9_417_686_910_695_060 wei) | PASS |
| Current block | recent mainnet | `24893781` | PASS |

No `PFPMinted` events found from earliest block to latest -- consistent with `ownerOf(0)` reverting. The collection is deployed and empty, ready for the first mint.

Note: the contract intentionally does not expose `totalSupply()`, `nextTokenId()`, or `owner()`. Mint count is derived client-side from `PFPMinted` events via `useScaffoldEventHistory`, per the audit-clean minimal-surface design.

## Frontend static verification

### Homepage (`/`)

| Check | Result |
|---|---|
| HTTP 200 | PASS |
| `<title>` is `Clawd PFP` (not `Scaffold-ETH 2`) | PASS |
| `<link rel="icon" href="/favicon.png">` present (not default SE2 logo) | PASS |
| `og:image` is absolute URL (`https://...ipfs.community.bgipfs.com/thumbnail.jpg`) | PASS (after rebuild) |
| String "CLAWD PFP" present in rendered HTML | PASS (3 occurrences) |
| String "Connect" present | PASS |
| String "Generate" present | PASS (9 occurrences -- prompt / button copy) |
| String "Mint" present | PASS |
| String "Gallery" present | PASS (navigation link) |
| No "scaffold-eth" branding in HTML | PASS |
| JS bundles load (webpack, main-app chunks) | PASS (HTTP 200 for sampled chunks) |

### Gallery (`/gallery/`)

| Check | Result |
|---|---|
| HTTP 200 | PASS |
| HTML payload ~14 KB (React shell) | PASS |

### Static assets

| Asset | Result |
|---|---|
| `/favicon.png` | HTTP 200 |
| `/thumbnail.jpg` (OG image) | HTTP 200 |
| `/logo.svg` | HTTP 200 |

## User journey traceability (from USERJOURNEY.md)

Each step from the design doc mapped to what is visible on the live site:

1. **Arrive at site** -- homepage renders with hero, countdown container, prompt input, connect button. PASS (HTML shell confirms; client renders countdown from `mintDeadline` via Wagmi).
2. **Connect wallet** -- RainbowKit button wired in (Phantom and Walletconnect present in connectors). PASS (source audit from Stage 7).
3. **Sign CV spend authorization** -- EIP-191 signature flow wired via wagmi `signMessage`. Requires live backend to actually charge CV -- see Known Limitations in README.
4. **Enter prompt, generate image** -- UI is live. Actual image generation requires the `/api/generate` route handler to run on a Node server, not the IPFS static export.
5. **Pay CV + mint** -- UI is live. Actual mint requires `/api/mint` to run on a Node server with `RELAYER_PRIVATE_KEY`.
6. **View in gallery** -- `/gallery/` renders the event-history-driven list. Zero items now (nothing minted yet), which is the expected empty state.
7. **Deadline passes** -- contract's `block.timestamp > mintDeadline` guard makes `mint()` revert forever; no off-chain shutdown step needed.

Items 3-5 depend on backend route handlers that are stubs and will not fire on the IPFS-only deploy. This is documented in the README. The contract and the frontend shell are both live and healthy.

## Issue found and fixed during walkthrough

**Problem:** On the original CID (`bafybeihhvt5ub6...24jyu`), the OG image tag rendered as `content="http://localhost:3000/thumbnail.jpg"`. Stage 7 QA lists "OG image uses absolute URL (`NEXT_PUBLIC_PRODUCTION_URL` checked first)" as a should-fix item -- the original build shipped without that env var set, so `getMetadata.ts` fell back to localhost.

**Fix applied:**
1. Added `NEXT_PUBLIC_PRODUCTION_URL=https://bafybeihhvt5ub6...24jyu.ipfs.community.bgipfs.com` to `packages/nextjs/.env.local`.
2. Rebuilt: `NEXT_PUBLIC_IPFS_BUILD=true yarn build` (7/7 static pages generated, no errors).
3. Re-uploaded via `npx bgipfs upload packages/nextjs/out`.
4. New CID: `bafybeihdb3xry4xr3zs575zybnciu7sjv5bdyu6n333xuyklozbwq7z3xa`.
5. Verified: new `og:image` resolves to an absolute IPFS gateway URL; the thumbnail URL itself returns HTTP 200.

The OG image URL points at the prior CID (not the new one) -- this is intentional and fine: the thumbnail is byte-identical between builds and the prior CID is still pinned and serving. For future rebuilds, the `NEXT_PUBLIC_PRODUCTION_URL` can be updated to the latest known-good CID before each build.

## Summary

End-to-end static verification passes. The contract is verified on Etherscan, exposes the expected immutables, and has zero mints (correct post-deploy state). The frontend renders with no SE2 branding, correct title and favicon, loads all JS bundles, and now serves absolute OG metadata.

No ship-blockers. The backend API integrations (larv.ai CV charge, PFP image generation, Pinata pinning) remain stubs as documented in the README and PLAN -- the client explicitly accepted that scope, and the contract is designed so those can be wired up later without any on-chain change.
