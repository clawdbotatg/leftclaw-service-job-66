# CLAWD PFP Generator

Generate custom AI-powered CLAWD lobster PFPs and mint them as permanent ERC-721 NFTs on Ethereum mainnet. Users pay in CV tokens; the server wallet sponsors every mint's gas, so end users never hold ETH.

## Live URLs

- **Frontend:** <https://bafybeihdb3xry4xr3zs575zybnciu7sjv5bdyu6n333xuyklozbwq7z3xa.ipfs.community.bgipfs.com/>
- **Contract (Etherscan):** <https://etherscan.io/address/0xB5741B033c45330A34952436a34b1B25a208Af10>

## Contract

| Field | Value |
|---|---|
| Chain | Ethereum mainnet (chainId 1) |
| Address | `0xB5741B033c45330A34952436a34b1B25a208Af10` |
| Minter | `0x5430757ee25f25D11987B206C1789d394a779200` |
| Mint deadline | Unix `1776963779` (~2026-04-23) |
| Verified | Yes, on Etherscan |

`ClawdPFP.sol` is an `ERC721` with two immutables (`minter`, `mintDeadline`), no owner, no admin, no upgrade path. After `mintDeadline`, `mint()` reverts forever -- walkaway safe.

## Architecture

- **Contract** (`packages/foundry/contracts/ClawdPFP.sol`) -- immutable ERC-721, minter-only `mint()` with a hard deadline.
- **Backend API routes** (`packages/nextjs/app/api/generate`, `.../mint`) -- dev-only stubs for the relayer flow: charge CV via larv.ai, generate image, pin to IPFS, call `mint()` from the relayer wallet. Not active on the live IPFS export (see Known Limitations).
- **Frontend** (`packages/nextjs/app/page.tsx`, `.../gallery/page.tsx`) -- connect wallet, sign CV spend, enter prompt, generate, mint, browse minted PFPs from `PFPMinted` events.
- **Integrations** -- larv.ai (CV token charging), PFP generation API, Pinata/bgipfs (IPFS pinning), Alchemy (mainnet RPC).

Full data flow and state machine: see [USERJOURNEY.md](./USERJOURNEY.md). Full build plan and design decisions: [PLAN.md](./PLAN.md).

## Local Development

### Prerequisites

- Node.js 20+
- Yarn 3+ (`corepack enable`)
- Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)

### Install

```bash
yarn install
```

### Run locally

Three terminals:

```bash
yarn chain          # Anvil local chain
yarn deploy         # Deploy ClawdPFP to local chain
yarn start          # Next.js dev server at http://localhost:3000
```

### Tests

```bash
cd packages/foundry && forge test
```

### Frontend-only dev

```bash
cd packages/nextjs && yarn dev
```

### Build for IPFS

```bash
cd packages/nextjs && NEXT_PUBLIC_IPFS_BUILD=true yarn build
# Output: packages/nextjs/out/
```

## Environment Variables

See `packages/nextjs/.env.example` for the full list. Key vars:

- `NEXT_PUBLIC_ALCHEMY_API_KEY` -- mainnet RPC (required for live contract reads)
- `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` -- RainbowKit WalletConnect
- `NEXT_PUBLIC_PRODUCTION_URL` -- absolute URL for OG image metadata (set to the deployed IPFS gateway URL before building for IPFS)
- `RELAYER_PRIVATE_KEY` -- minter wallet, server-side only, needed to run the `/api/mint` route
- `CV_SPEND_SECRET`, `PINATA_API_KEY`, `PINATA_SECRET` -- backend-only API integration keys

## Deployment

Contract was deployed via Foundry (`yarn deploy --network mainnet`) and verified with `yarn verify --network mainnet`. The Foundry broadcast record is in `packages/foundry/broadcast/`.

Frontend was built with `NEXT_PUBLIC_IPFS_BUILD=true yarn build` from `packages/nextjs/` and uploaded with `npx bgipfs upload packages/nextjs/out`.

See [PLAN.md](./PLAN.md) for the full deploy plan, gas/ETH bootstrap requirements, and the 7-day walkaway model.

## Known Limitations

- **API routes are not live on the IPFS build.** Next.js static export (`output: "export"`) does not ship route handlers. The `app/api/generate` and `app/api/mint` routes are dev-only stubs. Running the full gasless flow end-to-end in production requires hosting the API routes on a server that can run Node (Vercel, Railway, a VPS, etc.), or integrating them into a standalone relayer service.
- **larv.ai CV charging is a stub.** The `/api/generate` and `/api/mint` handlers accept the user's EIP-191 signature but do not yet call larv.ai's real CV-spend endpoint -- they need `CV_SPEND_SECRET` and the production larv.ai URL wired in.
- **PFP image generation is a stub.** Swap in the real generation provider (e.g. fal.ai, Replicate, OpenAI) inside `/api/generate`.
- **Pinata pinning is a stub.** `/api/mint` needs the real Pinata `pinFileToIPFS` and `pinJSONToIPFS` calls to pin the image and token metadata before calling `contract.mint()`.
- **In-memory rate limiting resets on restart.** Replace with Redis / Upstash for a multi-instance backend.

The contract itself is fully functional and verified -- once the backend services are wired in, the whole gasless mint loop runs without further on-chain changes.

## License

MIT. See [LICENCE](./LICENCE).
