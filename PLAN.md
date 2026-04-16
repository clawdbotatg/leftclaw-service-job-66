# PLAN.md — Gasless CLAWD PFP NFTs (Job #66)

## 1. Architecture Overview

This dApp is a two-step flow: **Generate** (pay CV to create a CLAWD PFP image) and **Mint** (pay CV to mint it as a permanent NFT on Ethereum mainnet with gas sponsored by a relayer).

### System Diagram

```
User Wallet (any chain)
    │
    ├─ Sign "larv.ai CV Spend" (EIP-191)
    │
    ▼
┌─────────────────────────────────────────┐
│  Next.js Frontend (SE2, IPFS-hosted)    │
│                                         │
│  Home/Generate Page:                    │
│    - Connect wallet                     │
│    - Type prompt → POST /api/generate   │
│    - See image → POST /api/mint         │
│                                         │
│  Gallery Page:                          │
│    - Grid of all minted PFPs            │
│    - Read from ClawdPFP contract        │
└────────┬───────────────┬────────────────┘
         │               │
    /api/generate    /api/mint
         │               │
         ▼               ▼
┌─────────────┐  ┌──────────────────────┐
│ larv.ai CV  │  │ Server-side Relayer   │
│ (charge CV) │  │                       │
└──────┬──────┘  │ 1. Charge CV          │
       │         │ 2. Pin image to IPFS   │
       ▼         │ 3. Pin metadata JSON   │
┌─────────────┐  │ 4. Call mint() on-chain│
│ LeftClaw    │  │    (relayer pays gas)  │
│ PFP API     │  └──────────┬─────────────┘
│ (generate)  │             │
└─────────────┘             ▼
                    ┌───────────────┐
                    │  ClawdPFP.sol │
                    │  (ETH Mainnet)│
                    └───────────────┘
```

### Key Architectural Decision: Relayer, Not ERC-4337

The spec mentions ERC-4337 / paymaster / UserOp, but the reference implementation (AA-GuestBook) uses a **simple relayer pattern** — EIP-712 signed messages relayed by a server wallet that pays gas. This is the correct pattern for this use case:

- The user never sends an on-chain transaction. They sign an EIP-191 message for CV spend. The server does everything else.
- The "paymaster" is simply the server wallet's ETH balance on mainnet.
- No bundler, no EntryPoint contract, no UserOp encoding needed.
- The server wallet (`minter` on the contract) calls `mint()` directly, paying gas from its own ETH balance.

This is functionally identical to what the spec describes ("gas fully sponsored") but with far less complexity. The AA-GuestBook repo confirms this is the intended pattern.

---

## 2. Smart Contracts

### 2.1 ClawdPFP.sol (Ethereum Mainnet)

```
ClawdPFP.sol
├── Inherits: ERC721 (OpenZeppelin v5)
├── State:
│   ├── address public immutable minter        — server wallet, set at deploy
│   ├── uint256 public immutable mintDeadline   — block.timestamp + 7 days at deploy
│   ├── uint256 private _tokenIdCounter         — starts at 0, increments each mint
│   └── mapping(uint256 => string) private _tokenURIs — IPFS URIs, set once
├── Functions:
│   ├── constructor(address _minter)            — sets minter + mintDeadline
│   ├── mint(address to, string calldata tokenURI) — minter-only, before deadline
│   └── tokenURI(uint256 tokenId) → string      — override, reads _tokenURIs
├── Events:
│   └── PFPMinted(uint256 indexed tokenId, address indexed to, string prompt)
└── Security:
    ├── No setTokenURI — URIs are immutable after mint
    ├── No setMinter — minter is immutable
    ├── No pause, no owner, no upgrade path
    └── After mintDeadline, mint() reverts permanently — walkaway safe
```

**Design Notes:**
- Uses OZ v5 ERC721 (not ERC721URIStorage — we store URIs manually for immutability control).
- `_tokenIdCounter` is a plain uint256, not OZ Counters (deprecated in v5).
- The `prompt` field in `PFPMinted` event is metadata-only (stored in event logs for gallery display). It is NOT the tokenURI — the tokenURI is an IPFS link to the full metadata JSON.
- No `Ownable` — the only privileged role is `minter`, which is immutable.

### 2.2 Deployment Plan

- **Network:** Ethereum Mainnet
- **Deploy script:** `packages/foundry/script/DeployClawdPFP.s.sol`
- **Constructor args:** `minter` = worker/server wallet address (from .env PRIVATE_KEY)
- **Verification:** `yarn verify --network mainnet` (SE2 built-in, no Etherscan API key needed)
- **scaffold.config.ts:** Change `targetNetworks` from `chains.foundry` to `chains.mainnet`
- **foundry.toml:** Mainnet RPC already configured with Alchemy: `https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_API_KEY}`

### 2.3 What About the Paymaster Contract?

There is no separate paymaster contract. The "paymaster" in this architecture is the server wallet's ETH balance. The server wallet:
1. Is set as `minter` on ClawdPFP
2. Calls `mint()` on behalf of users
3. Pays gas from its own ETH balance
4. Recoups cost because users pay CV (off-chain) before each mint

This follows the AA-GuestBook pattern exactly — the relayer wallet IS the gas sponsor.

---

## 3. Backend API

All API routes live in `packages/nextjs/app/api/`. They run server-side in Next.js and hold the server wallet private key.

### 3.1 POST /api/generate

**Purpose:** Charge CV, generate a CLAWD PFP image via the LeftClaw PFP API.

```
Request:
{
  "prompt": "wearing a cowboy hat",
  "wallet": "0xUserAddress",
  "signature": "0x..."  // EIP-191 sig of "larv.ai CV Spend"
}

Flow:
1. Validate inputs (prompt length, wallet format, signature present)
2. Check mintDeadline — if expired, return 410 Gone ("minting window closed")
3. Check CV balance via GET https://larv.ai/api/cv/balance?address={wallet}
4. If balance < GENERATE_CV_COST, return 402 with balance info
5. Charge CV via POST https://larv.ai/api/cv/spend (server-side, using CV_SPEND_SECRET + user signature)
6. Call POST https://leftclaw.services/api/pfp/generate-cv with worker wallet auth
   - The PFP API also charges CV — BUT we use the worker wallet's CV, not the user's
   - Actually: use the CV endpoint which charges from the wallet that signed
   - Decision point: see Open Questions #1
7. Return { image: "data:image/png;base64,...", prompt, cvSpent, newBalance }

Error handling:
- If PFP API fails AFTER CV was charged → attempt CV refund? See Open Questions #2
- Rate limit: max 5 generates per wallet per hour (in-memory Map, cleared on restart)
```

**CV Cost for Generate:** A smaller amount (e.g., 100,000 CV). Exact amount TBD — should match or be less than the PFP API's own CV cost (500,000 CV per the skill.md).

### 3.2 POST /api/mint

**Purpose:** Charge CV, pin image+metadata to IPFS, mint the NFT on mainnet.

```
Request:
{
  "imageDataUrl": "data:image/png;base64,...",
  "prompt": "wearing a cowboy hat",
  "wallet": "0xUserAddress",
  "signature": "0x..."  // Same EIP-191 sig of "larv.ai CV Spend"
}

Flow:
1. Validate inputs
2. Check mintDeadline on-chain — if expired, return 410 Gone
3. Check CV balance — if < MINT_CV_COST, return 402
4. Charge CV via larv.ai /spend endpoint
5. Pin image to IPFS:
   a. Decode base64 image to buffer
   b. Upload to IPFS via bgipfs (or Pinata/nft.storage — see Open Questions #3)
   c. Get image CID → ipfs://{imageCID}
6. Build ERC-721 metadata JSON:
   {
     "name": "CLAWD PFP #{tokenId}",
     "description": "Custom CLAWD PFP: {prompt}",
     "image": "ipfs://{imageCID}",
     "attributes": [
       { "trait_type": "Prompt", "value": "{prompt}" },
       { "trait_type": "Minted By", "value": "{wallet}" }
     ]
   }
7. Pin metadata JSON to IPFS → metadataCID
8. tokenURI = "ipfs://{metadataCID}"
9. Server wallet calls ClawdPFP.mint(wallet, tokenURI) on mainnet
   - Use viem walletClient with server private key
   - Wait for transaction receipt
10. Return { txHash, tokenId, tokenURI, ipfsImageUrl }

Error handling:
- If mint tx fails AFTER CV charged → log error, notify, consider refund mechanism
- If IPFS pin fails → return error BEFORE charging CV (reorder: pin first, charge second?)
- Transaction simulation before sending to catch reverts early
```

**CV Cost for Mint:** A larger amount (e.g., 1,000,000 CV). This covers the gas cost the server pays.

### 3.3 Server Wallet Management

The server wallet (same as the worker wallet `0x5430757ee25f25D11987B206C1789d394a779200`) needs:
- **ETH on mainnet** for gas (each mint costs ~80-150k gas, roughly $0.50-2.00 at current gas prices)
- **Private key** in `.env` as `PRIVATE_KEY` (already present for the worker bot)

The API routes load the private key from `process.env.PRIVATE_KEY` and create a viem walletClient. This is the same pattern as AA-GuestBook's `/api/relay/route.ts`.

### 3.4 GET /api/gallery

**Purpose:** Return all minted PFPs with metadata.

```
Flow:
1. Read _tokenIdCounter from contract (or use PFPMinted events)
2. For each token: read tokenURI, owner, and extract prompt from PFPMinted event
3. Return array of { tokenId, owner, tokenURI, prompt, imageUrl }

Optimization:
- Cache results in memory, invalidate on new PFPMinted events
- Or: read events via useScaffoldEventHistory on the frontend directly
```

**Alternative:** Skip the API route entirely. The frontend can read all data directly from the contract using SE2 hooks (`useScaffoldEventHistory` for PFPMinted events + `useScaffoldReadContract` for tokenURI/ownerOf). This is simpler and avoids server-side caching. Recommended approach.

---

## 4. Frontend

### 4.1 Pages

#### Home/Generate Page (`/`)

**Layout:**
```
┌─────────────────────────────────────────┐
│  CLAWD PFP Generator                    │
│  [Connect Wallet]                       │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ Your CV Balance: 1,234,567 CV   │    │
│  └─────────────────────────────────┘    │
│                                         │
│  Describe your CLAWD:                   │
│  ┌─────────────────────────────────┐    │
│  │ wearing a cowboy hat...         │    │
│  └─────────────────────────────────┘    │
│  [Generate PFP] (costs 500,000 CV)      │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │                                 │    │
│  │    [Generated Image Preview]    │    │
│  │                                 │    │
│  └─────────────────────────────────┘    │
│  [Mint as NFT] (costs 1,000,000 CV)     │
│                                         │
│  ── After Mint Deadline ──              │
│  "Minting window closed. Collection     │
│   is frozen forever."                   │
│  [View Gallery →]                       │
└─────────────────────────────────────────┘
```

**UX Flow:**
1. User connects wallet (RainbowKit)
2. If wrong network → show "Switch to Ethereum Mainnet" button (but note: user doesn't need to be on mainnet since they never send a tx — they just sign a message. However, the frontend reads contract state from mainnet, so targetNetwork should be mainnet.)
3. Display CV balance (fetched from larv.ai API — client-side, CORS is open)
4. User types prompt, clicks "Generate PFP"
5. Frontend requests EIP-191 signature of "larv.ai CV Spend" via wagmi's `useSignMessage`
6. POST /api/generate with prompt, wallet, signature
7. Display generated image
8. User clicks "Mint as NFT"
9. POST /api/mint with image, prompt, wallet, signature (reuse same signature — it's a static message)
10. Show tx hash with link to Etherscan, show minted NFT

**Countdown Timer:**
- Display time remaining until mintDeadline
- Read `mintDeadline` from contract via `useScaffoldReadContract`
- When expired, hide generate/mint UI, show "Collection Frozen" state

#### Gallery Page (`/gallery`)

**Layout:**
```
┌─────────────────────────────────────────┐
│  CLAWD PFP Gallery                      │
│  {totalMinted} PFPs minted              │
│  {timeRemaining} until collection freeze│
│                                         │
│  ┌───────┐  ┌───────┐  ┌───────┐       │
│  │ img1  │  │ img2  │  │ img3  │       │
│  │ #1    │  │ #2    │  │ #3    │       │
│  │ 0xAb..│  │ 0xCd..│  │ 0xEf..│       │
│  │"cowboy│  │"pirate│  │"space │       │
│  │  hat" │  │  ship"│  │  suit"│       │
│  └───────┘  └───────┘  └───────┘       │
│                                         │
│  ┌───────┐  ┌───────┐  ┌───────┐       │
│  │ img4  │  │ img5  │  │ img6  │       │
│  │ ...   │  │ ...   │  │ ...   │       │
│  └───────┘  └───────┘  └───────┘       │
└─────────────────────────────────────────┘
```

**Data Source:**
- Read `PFPMinted` events via `useScaffoldEventHistory`
- For each event: tokenId, owner (the `to` field), prompt (from event)
- Fetch tokenURI from contract → resolve IPFS metadata → get image URL
- Display in a responsive grid (3 columns desktop, 2 tablet, 1 mobile)

### 4.2 Components

| Component | Purpose |
|-----------|---------|
| `CVBalance` | Fetches and displays user's CV balance from larv.ai |
| `GenerateForm` | Prompt input + Generate button + loading state |
| `PFPPreview` | Shows generated image + Mint button |
| `MintButton` | Handles signature + mint API call + tx confirmation |
| `CountdownTimer` | Shows time remaining until mintDeadline |
| `FrozenBanner` | Displayed after mintDeadline — collection is frozen |
| `PFPCard` | Gallery card for a single NFT (image, token ID, owner, prompt) |
| `PFPGrid` | Responsive grid of PFPCards |

### 4.3 State Management

No external state library needed. React state + wagmi hooks are sufficient:
- Wallet connection: wagmi/RainbowKit
- Contract reads: SE2 `useScaffoldReadContract` / `useScaffoldEventHistory`
- CV balance: `useState` + fetch from larv.ai on wallet connect
- Generated image: `useState` for current session image
- Mint status: `useState` for loading/success/error

### 4.4 Network Configuration

- `scaffold.config.ts`: Change `targetNetworks` to `[chains.mainnet]`
- `pollingInterval`: 12000 (mainnet blocks are ~12s)
- The user signs EIP-191 messages (chain-agnostic) — they don't need ETH

---

## 5. External Integrations

### 5.1 larv.ai CV API

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/cv/balance?address=` | GET | Check CV balance | None (public, CORS open) |
| `/api/cv/spend` | POST | Charge CV | CV_SPEND_SECRET + user EIP-191 sig |

- **Signature:** User signs `"larv.ai CV Spend"` via `useSignMessage` — this is a static string, same signature works for both generate and mint in the same session.
- **Important:** The signature is a bearer token — anyone holding it can spend CV from that wallet. Frontend should request it once per session and hold in memory only.
- **Server-side only:** `/spend` endpoint called from API routes only. Never expose `CV_SPEND_SECRET` to the client.

### 5.2 LeftClaw PFP API

| Endpoint | Method | Purpose | Payment |
|----------|--------|---------|---------|
| `/api/pfp/generate-cv` | POST | Generate CLAWD PFP image | CV (500,000 CV from the signing wallet) |

- Uses the CV payment path (not x402/USDC) since users are already paying CV.
- **Problem:** The PFP API charges CV from the wallet that signed the message. If the user signs, the user pays. If the server signs, the server pays.
- **Solution:** The server (worker wallet) signs its own "larv.ai CV Spend" message and calls `/api/pfp/generate-cv` with the worker wallet + worker signature. The cost to the server is recouped by charging the user a higher CV amount via the separate `/api/cv/spend` call. See Open Questions #1 for alternative approaches.

### 5.3 IPFS Pinning

Images and metadata need persistent IPFS pinning for NFT permanence.

**Option A: bgipfs** (already available in the project)
- `npx bgipfs upload <file>` — uploads a file and returns a CID
- Good for frontend deploys, but may not have a programmatic API for individual file pinning from Node.js

**Option B: Pinata / nft.storage / web3.storage**
- Programmatic Node.js SDKs designed for NFT metadata
- Pinata: `pinata.pinFileToIPFS()` and `pinata.pinJSONToIPFS()`
- Preferred for this use case — need to pin individual images and JSON metadata programmatically

**Recommendation:** Use Pinata for IPFS pinning. Add `PINATA_API_KEY` and `PINATA_SECRET` to `.env`. The bgipfs tool is for static site deployment, not programmatic file pinning.

### 5.4 Contract Interaction (Server-side Relayer)

The server wallet calls `mint()` directly using viem:

```
Server-side pattern (from AA-GuestBook /api/relay):
1. Load PRIVATE_KEY from env
2. privateKeyToAccount(PRIVATE_KEY)
3. createWalletClient({ account, chain: mainnet, transport: http(alchemyRPC) })
4. walletClient.writeContract({ address: ClawdPFP, abi, functionName: "mint", args: [to, tokenURI] })
5. publicClient.waitForTransactionReceipt({ hash })
```

RPC: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` — never a public RPC.

---

## 6. Security Considerations

### 6.1 Prompt Injection

- **Risk:** Malicious prompts could attempt to manipulate the PFP generation model.
- **Mitigation:** The LeftClaw PFP API handles prompt sanitization on its end. On our side: limit prompt length (max 280 chars), strip HTML/script tags, validate it's a string.

### 6.2 Server Wallet / Relayer Security

- **Risk:** Private key exposure, unauthorized mint calls.
- **Mitigation:**
  - Private key in `.env` only, never in client-side code, never in git
  - API routes are server-side only (Next.js API routes don't expose to client)
  - Rate limiting per wallet address (prevents a single user from draining server ETH)
  - Monitor server wallet ETH balance — alert if below threshold

### 6.3 Paymaster / Gas Drainage

- **Risk:** An attacker could repeatedly call /api/mint to drain the server wallet's ETH.
- **Mitigation:**
  - Every mint costs CV — attacker must have real CV balance to spend
  - Rate limit: max 3 mints per wallet per hour
  - CV charge happens BEFORE the on-chain mint — if charge fails, no gas spent
  - Monitor: if server ETH balance < 0.05 ETH, return 503 "Minting temporarily unavailable"

### 6.4 CV Signature Replay

- **Risk:** The EIP-191 signature of "larv.ai CV Spend" is static — it can be replayed.
- **Mitigation:** The larv.ai API handles idempotency/rate-limiting on their end. On our end:
  - Only accept each signature once per session (server-side session tracking)
  - Actually — the larv.ai docs note the signature IS a bearer token. Our mitigation: charge CV atomically (check balance + deduct in one call), and the user explicitly clicks "Generate" or "Mint" to consent each time.

### 6.5 Time Lock Immutability

- **Risk:** None — this is a feature. After mintDeadline, the contract is permanently frozen.
- **Frontend:** Must clearly communicate the countdown and "frozen forever" state.
- **Server:** Must check `block.timestamp <= mintDeadline` before attempting mint to avoid wasting gas on a guaranteed revert.

### 6.6 Token URI Immutability

- **Risk:** If IPFS pins are lost, NFT metadata becomes unretrievable.
- **Mitigation:** Use a reliable pinning service (Pinata with paid plan). Consider pinning to multiple services. The tokenURI is set once and can never be changed — the metadata must be pinned permanently.

### 6.7 Worker Wallet Dual Use

- **Risk:** The worker wallet (0x5430...) is both the LeftClaw bot wallet and the minter. If its ETH is depleted on mainnet, it can't mint.
- **Mitigation:** Fund the worker wallet with enough ETH for the expected 7-day minting volume. Monitor balance. Budget: ~200 mints x $1.50 gas = ~$300 in ETH as a starting fund.

---

## 7. Deployment Plan

### Phase 1: Local Development (Anvil Fork)

1. Write and compile ClawdPFP.sol
2. Run `yarn chain` (local Anvil)
3. Deploy to local chain
4. Build frontend with mock PFP generation (return a placeholder image)
5. Test full flow: connect wallet → generate (mock) → mint → gallery
6. Verify contract reads work (mintDeadline, tokenURI, events)

### Phase 2: Mainnet Contract + Local UI

1. Update `scaffold.config.ts` to `chains.mainnet`
2. Update `foundry.toml` etherscan section for mainnet verification
3. Fund worker wallet with ETH on mainnet
4. Deploy ClawdPFP to mainnet: `yarn deploy --network mainnet`
5. Verify on Etherscan: `yarn verify --network mainnet`
6. Test with real PFP API and real CV charges
7. Test mint flow end-to-end with real mainnet transaction

### Phase 3: Production (IPFS Deploy)

1. Remove SE2 branding (footer, tab title, README, favicon)
2. Disable block explorer pages (rename to `_blockexplorer-disabled`)
3. Add polyfill-localstorage.cjs to `packages/nextjs/`
4. `yarn build` (static export to `packages/nextjs/out/`)
5. `npx bgipfs upload packages/nextjs/out`
6. Verify live URL returns HTTP 200
7. Verify CID is new (not a previous build)
8. Submit as job deliverable

### Environment Variables Required

```
# Already in .env
PRIVATE_KEY=          # Worker/server wallet private key
ALCHEMY_API_KEY=      # For mainnet RPC

# New — need to add
CV_SPEND_SECRET=      # From larv.ai team, for charging CV
PINATA_API_KEY=       # For IPFS pinning (if using Pinata)
PINATA_SECRET=        # For IPFS pinning
NEXT_PUBLIC_ALCHEMY_API_KEY=  # For frontend contract reads
```

---

## 8. Open Questions / Risks

### Q1: PFP API Payment Flow — Who Pays?

The LeftClaw PFP API's CV endpoint (`/api/pfp/generate-cv`) charges CV from the wallet that signed the message. Two options:

**Option A: User pays PFP API directly**
- User signs "larv.ai CV Spend", frontend passes signature to /api/generate
- Server forwards wallet+signature to PFP API — user's CV is charged by PFP API
- Server also charges additional CV via larv.ai /spend for our own fee
- Problem: User gets charged twice (once by PFP API, once by us). Confusing UX.

**Option B: Server wallet pays PFP API, user pays us (RECOMMENDED)**
- Server wallet signs its own "larv.ai CV Spend" message (at startup or cached)
- Server calls PFP API with worker wallet + worker signature — worker's CV is charged
- Server charges user CV via larv.ai /spend for the full cost (our fee + PFP API cost)
- User sees one clear charge. Server absorbs PFP API cost and recoups via higher user charge.
- Requirement: Worker wallet must have CV balance on larv.ai.

### Q2: CV Refund on Failure

If CV is charged but the downstream operation fails (PFP API error, IPFS pin failure, mint tx revert), should we refund CV?

- larv.ai /spend is a one-way deduction — there's no /refund endpoint documented
- **Mitigation:** Order operations to minimize risk:
  1. Validate everything that can be validated upfront (deadline, balance, rate limits)
  2. Call the external API (PFP generation or IPFS pin)
  3. Charge CV only AFTER the risky operation succeeds
  4. For mint: pin to IPFS first, then charge CV, then send tx
- **Risk:** If the mint tx reverts after CV is charged, the user loses CV. This should be extremely rare (we simulate the tx first), but it's not zero.

### Q3: IPFS Pinning Service

- bgipfs is designed for static site deploys, not programmatic file pinning from API routes
- Need to confirm: does bgipfs have a Node.js API, or is it CLI-only?
- If CLI-only, use Pinata (well-documented Node.js SDK, reliable pinning)
- Alternative: use nft.storage (free, designed for NFTs, but has had reliability issues)
- **Recommendation:** Pinata unless bgipfs has a programmatic API

### Q4: Signature Reuse Between Generate and Mint

The user signs "larv.ai CV Spend" once. Can this same signature be reused for both the generate and mint steps?

- Yes — the larv.ai API uses the signature as a bearer token. Each /spend call with the same signature succeeds as long as the wallet has balance.
- Frontend should request the signature once (on first action) and cache it in React state for the session.
- Security note: the signature doesn't expire. If the page is left open, it remains valid. This is acceptable since the user explicitly initiated the session.

### Q5: Mint Deadline Timezone

- `block.timestamp + 7 days` at deployment — the deadline is in UTC (block timestamps are Unix epoch).
- Frontend should display countdown in the user's local timezone.
- Edge case: if a mint is submitted seconds before deadline, the tx might land in a block after deadline and revert. Mitigation: stop accepting mints 5 minutes before deadline (grace period).

### Q6: What Happens to the Frontend After Minting Closes?

- The IPFS-hosted frontend lives forever.
- After mintDeadline: generate/mint buttons are hidden, gallery remains accessible.
- The frontend becomes a permanent gallery / viewer for the frozen collection.
- No server dependency for viewing — all data is on-chain + IPFS.

### Q7: Token ID in Metadata

The metadata JSON includes `"name": "CLAWD PFP #{tokenId}"` — but tokenId is only known after the mint tx. Options:
- **Option A:** Predict tokenId by reading `_tokenIdCounter` before minting (risk: race condition if two mints happen simultaneously)
- **Option B:** Use a generic name without tokenId (e.g., "CLAWD PFP") — simpler, no race condition
- **Option C:** Read counter, use optimistic tokenId, accept rare edge case
- **Recommendation:** Option A with simulation — read counter, simulate tx to confirm tokenId, then pin metadata. If simulation shows a different tokenId, re-pin.

### Q8: Client Wallet on What Chain?

The user's wallet doesn't need to be on Ethereum mainnet since they never send a transaction. They only sign an EIP-191 message (chain-agnostic). However:
- The frontend reads contract state from mainnet (mintDeadline, events for gallery)
- SE2's `targetNetwork` should be `chains.mainnet` so contract reads work
- RainbowKit will prompt users to switch to mainnet — this is fine and expected
- Users on Base/other chains CAN still sign messages, but they'll see "Wrong Network" unless we handle this carefully

**Recommendation:** Set targetNetwork to mainnet. The "switch network" prompt is appropriate because the frontend needs to read mainnet contract state. Document in the UI that no ETH is needed — signing is free.
