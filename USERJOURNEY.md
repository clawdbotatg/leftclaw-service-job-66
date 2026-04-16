# User Journey -- Gasless CLAWD PFP NFTs

This document maps every user interaction, edge case, and UI state for the CLAWD PFP Generator dApp. The dApp is a two-step flow: **Generate** (pay CV to create an AI lobster PFP) and **Mint** (pay CV to permanently mint it as an ERC-721 NFT on Ethereum mainnet, gas-free). After a 7-day window, the collection freezes permanently.

---

## Happy Path

### Step 1: Landing

The user navigates to the IPFS-hosted site. They see:

- The **CLAWD PFP Generator** title/logo
- A **Connect Wallet** button (RainbowKit)
- A **countdown timer** showing time remaining until the mint deadline (e.g., "4d 12h 37m left")
- A brief explainer: "Create a custom CLAWD lobster PFP and mint it as an NFT on Ethereum. No gas needed -- we cover it."
- A **Gallery** link in the navigation to browse already-minted PFPs
- The generate/mint controls are **hidden or disabled** until the wallet is connected

### Step 2: Connect Wallet

The user clicks **Connect Wallet**. RainbowKit opens with wallet options (MetaMask, Coinbase Wallet, WalletConnect, Phantom, etc.). The user selects their wallet and approves the connection.

- If the user is on the wrong network, they see a **Switch to Ethereum Mainnet** button (see Edge Cases below).
- Once connected on mainnet, the UI transitions: the Connect button is replaced with the user's address/avatar, and the generate form appears.

### Step 3: View CV Balance and Countdown

After connecting, the user sees:

- **CV Balance** displayed prominently (e.g., "Your CV: 2,500,000"). This is fetched client-side from `GET https://larv.ai/api/cv/balance?address={wallet}`.
- **Cost breakdown**: "Generate: 500,000 CV | Mint: 1,000,000 CV"
- **Countdown timer** ticking down to mintDeadline (read from the contract via `useScaffoldReadContract`)

### Step 4: Type Prompt and Click Generate PFP

The user enters a description in the text input (max 280 characters), e.g., "wearing a cowboy hat with laser eyes". They click the **Generate PFP** button.

- The button shows the cost: "Generate PFP (500,000 CV)"
- If this is the user's first action in the session, the wallet prompts them to **sign an EIP-191 message** (Step 5 below). If they already signed earlier in the session, the cached signature is reused and this step is skipped.

### Step 5: Sign EIP-191 Message for CV Spend Authorization

A wallet popup appears asking the user to sign the message `"larv.ai CV Spend"`. This is an off-chain signature -- it costs no gas and sends no transaction. The signature acts as a bearer token authorizing the backend to charge CV from the user's balance.

- The UI explains: "Sign this message to authorize CV spending. This is free -- no gas required."
- On approval, the signature is cached in React state for the remainder of the session (used for both generate and mint).
- On rejection, the generate action is cancelled and the user returns to the form.

### Step 6: Wait for Image Generation

After signing (or if a cached signature exists), the frontend sends `POST /api/generate` with the prompt, wallet address, and signature. The UI transitions to a **loading state**:

- The Generate button becomes disabled and shows a spinner with "Generating your CLAWD..." text
- An estimated wait time is shown: "This usually takes 10-30 seconds"
- The prompt input is locked (non-editable) during generation

The backend:
1. Validates inputs
2. Checks the mint deadline
3. Verifies CV balance >= generate cost
4. Charges CV via larv.ai
5. Calls the LeftClaw PFP API to generate the image
6. Returns the image as a base64 data URL

### Step 7: See Generated PFP Image

The loading state resolves and the generated PFP image appears in a large preview area. The user sees:

- The AI-generated lobster PFP image
- Their prompt displayed below the image
- The CV spent for generation
- Their updated CV balance
- A prominent **Mint as NFT** button below the image, showing the cost: "Mint as NFT (1,000,000 CV)"
- A secondary **Generate Again** button (to try a different prompt, costs another 500,000 CV)

### Step 8: Click Mint as NFT

The user clicks **Mint as NFT**.

- If the user's CV balance is less than the mint cost, the button is disabled with a tooltip: "Insufficient CV balance" (see Edge Cases).
- Since the EIP-191 signature was already signed in Step 5 and cached, no second wallet popup appears. The mint request fires immediately.

### Step 9: Sign Mint CV Spend (if needed)

If the session signature has been invalidated or this is a fresh page load, the wallet prompts for another EIP-191 signature of `"larv.ai CV Spend"`. Otherwise, the cached signature from Step 5 is reused and this step is transparent to the user.

### Step 10: Wait for Mint Transaction

The frontend sends `POST /api/mint` with the image data URL, prompt, wallet address, and signature. The UI transitions to a **multi-step progress indicator**:

1. "Charging CV..." (backend charges CV via larv.ai)
2. "Pinning image to IPFS..." (backend uploads image to IPFS)
3. "Pinning metadata..." (backend creates and pins ERC-721 metadata JSON)
4. "Minting on Ethereum..." (backend's server wallet sends the `mint()` transaction)
5. "Waiting for confirmation..." (backend waits for the transaction receipt)

Estimated total time: 15-30 seconds. The Mint button is disabled and shows a spinner throughout.

The backend:
1. Validates inputs
2. Checks mintDeadline on-chain
3. Verifies CV balance >= mint cost
4. Charges CV
5. Decodes the base64 image and pins it to IPFS
6. Builds ERC-721 metadata JSON and pins it to IPFS
7. Calls `ClawdPFP.mint(userWallet, tokenURI)` from the server wallet (relayer pays gas)
8. Waits for the transaction receipt
9. Returns the tx hash, token ID, and token URI

### Step 11: See Confirmation

The mint succeeds. The UI shows a **success state**:

- The minted PFP image, now labeled "CLAWD PFP #[tokenId]"
- A link to the transaction on Etherscan: "View on Etherscan" (links to `https://etherscan.io/tx/[txHash]`)
- The token ID and owner address (displayed with the SE2 `<Address/>` component)
- The updated CV balance after both charges
- A **View in Gallery** button
- A **Generate Another** button to start the flow over

### Step 12: Visit Gallery

The user navigates to the Gallery page (via nav link or the "View in Gallery" button). They see:

- A header: "CLAWD PFP Gallery" with the total number of minted PFPs
- The countdown timer (or "Collection Frozen" if past deadline)
- A responsive grid of all minted PFPs (3 columns desktop, 2 tablet, 1 mobile)
- Each card shows:
  - The PFP image (loaded from IPFS via the tokenURI metadata)
  - Token ID (e.g., "#7")
  - Owner address (with the `<Address/>` component -- shows ENS name if available)
  - The prompt used to generate it (from the `PFPMinted` event logs)
- Cards are sorted newest-first (highest token ID first)

---

## Edge Cases

### No Wallet Installed

**Trigger:** User visits the site without MetaMask, Coinbase Wallet, or any browser wallet extension.

**What they see:**
- The landing page renders normally with the countdown timer and explainer text
- Clicking **Connect Wallet** opens the RainbowKit modal
- The modal shows available connection methods: WalletConnect QR code, Coinbase Wallet (which offers a guided install flow), and optionally a "Get a Wallet" link
- If the user has no wallet at all, they can scan the WalletConnect QR code with a mobile wallet app
- The generate/mint controls remain hidden or disabled until a wallet is connected

**Resolution:** The user either installs a wallet extension, scans the WalletConnect QR with a mobile wallet, or uses Coinbase Wallet's onboarding flow.

---

### Wrong Network

**Trigger:** User connects their wallet but is on Base, Polygon, Sepolia, or any chain other than Ethereum mainnet.

**What they see:**
- After connecting, instead of the generate form, the user sees a **"Switch to Ethereum Mainnet"** button (SE2's built-in network switching via RainbowKit)
- A short explanation: "This app reads data from Ethereum mainnet. Please switch networks to continue."
- The generate form, CV balance, and mint controls are **not shown** until the user is on the correct network
- The Gallery page still attempts to load (since it reads from mainnet RPC regardless of the user's network), but the generate/mint flow is gated

**Why mainnet is required:** Even though the user never sends an on-chain transaction (they only sign EIP-191 messages, which are chain-agnostic), the SE2 frontend's `targetNetwork` is set to `chains.mainnet` so contract reads (mintDeadline, events for gallery) work correctly. RainbowKit enforces this.

**Resolution:** The user clicks "Switch to Ethereum Mainnet" and their wallet prompts them to switch. Once on mainnet, the full UI appears. No ETH is needed in their wallet -- signing is free.

---

### Insufficient CV Balance

**Trigger:** The user's CV balance is below the cost required for the action they want to take.

**Scenario A -- Not enough CV to generate (balance < 500,000 CV):**
- The **Generate PFP** button is disabled
- A message below the button: "You need at least 500,000 CV to generate a PFP. Your balance: [X] CV."
- A link to earn/acquire CV (e.g., pointing to larv.ai or the CV faucet if one exists)

**Scenario B -- Enough CV to generate but not to mint (500,000 <= balance < 1,500,000 CV):**
- The user can generate a PFP (costs 500,000 CV)
- After generation, the **Mint as NFT** button is disabled
- A message: "You need 1,000,000 CV to mint. Your balance: [X] CV."
- The generated image remains visible so the user can return later when they have more CV

**Scenario C -- Balance drops below cost mid-session:**
- The user starts with enough CV, generates a PFP (balance decreases), but the new balance is now below the mint cost
- Same behavior as Scenario B -- the mint button is disabled with a balance message
- The generated image is preserved in React state so the user does not lose their creation

**Resolution:** The user acquires more CV and returns. The generated image is only persisted in the current browser session (React state), so if they close the tab, they lose the generated image and must generate again.

---

### Mint Deadline Passed

**Trigger:** The user arrives at the site after the 7-day minting window has expired (`block.timestamp > mintDeadline`).

**What they see:**
- The countdown timer reads **"Collection Frozen"** or **"Minting Closed"**
- The generate form and mint button are **completely removed** from the page (not just disabled -- hidden)
- A banner or prominent notice: "The CLAWD PFP collection is permanently frozen. No new PFPs can be generated or minted."
- A **View Gallery** button directing them to browse the final collection
- The Gallery page works normally -- it is a permanent viewer for the frozen collection

**Technical detail:** The frontend reads `mintDeadline` from the contract and compares it to the current block timestamp. If `block.timestamp > mintDeadline`, the "frozen" state is rendered.

**Resolution:** None -- this is permanent by design. The collection is immutable after the deadline.

---

### Mint Deadline Passes Mid-Session

**Trigger:** The user starts a session before the deadline, generates a PFP, but the deadline expires before they click Mint.

**Scenario A -- Deadline expires while viewing the generated image:**
- The countdown timer reaches zero
- The **Mint as NFT** button becomes disabled
- A message replaces or overlays the mint area: "The minting window has closed while you were here. Your generated image cannot be minted."
- The generate form is also disabled

**Scenario B -- Deadline expires during the mint API call:**
- The frontend sends `POST /api/mint`
- The backend checks `mintDeadline` on-chain before attempting the transaction
- If expired, the backend returns **410 Gone** with message: "Minting window has closed"
- Critically: the backend checks the deadline **before** charging CV, so no CV is lost
- The frontend shows an error: "The minting window closed before your mint could complete. No CV was charged."

**Scenario C -- Race condition (deadline expires between CV charge and mint tx):**
- The backend charges CV, then the `mint()` transaction reverts because `block.timestamp > mintDeadline`
- The user loses the mint CV (the backend cannot refund CV -- there is no refund endpoint)
- Mitigation: the backend stops accepting mints 5 minutes before the deadline (grace period) to prevent this edge case
- If it still happens: the frontend shows an error explaining the situation and the user can contact support

**Resolution:** The user cannot mint. Their generated image is lost (not persisted beyond the session). The 5-minute grace period makes Scenario C extremely unlikely.

---

### PFP Generation Fails

**Trigger:** The LeftClaw PFP API returns an error during image generation.

**What the user sees:**
- The loading spinner is replaced with an error message: "Image generation failed. Please try again."
- The error is non-specific to the user (no raw API error details exposed)

**CV handling depends on when the failure occurs:**

- **Before CV charge** (validation/deadline/balance check failed): No CV is charged. The user can retry immediately.
- **After CV charge but PFP API fails**: The user loses the generate CV cost. The backend logs the failure. The frontend shows: "Generation failed. Your CV was charged but no image was produced. We apologize for the inconvenience."
  - Mitigation: The backend should order operations to charge CV **after** calling the PFP API if possible. However, the PFP API itself charges CV from the worker wallet, so the user's CV charge and the PFP API call are separate. The recommended flow: call PFP API first (which charges the worker wallet's CV), and only charge the user's CV if the image is successfully returned.

**Resolution:** The user clicks **Try Again** to re-enter a prompt and attempt generation again.

---

### Mint Transaction Fails

**Trigger:** The on-chain `mint()` call reverts after the backend has already charged CV and pinned to IPFS.

**Possible revert reasons:**
- `mintDeadline` passed (covered above)
- Server wallet is not the `minter` (deployment misconfiguration -- should never happen in production)
- Out of gas (extremely unlikely with a simple mint)

**What the user sees:**
- The progress indicator stops at "Minting on Ethereum..."
- An error message appears: "The mint transaction failed on-chain. Your CV has been charged but the NFT was not created. Please contact support with this error ID: [errorId]."
- The IPFS-pinned image and metadata remain pinned but have no corresponding on-chain token

**CV refund:** No automatic refund is possible (larv.ai has no `/refund` endpoint). The loss is logged server-side for manual resolution.

**Mitigation:** The backend simulates the transaction before sending it (`eth_call`). If the simulation reverts, the backend returns an error **before** charging CV. This makes post-charge reverts extremely rare.

**Resolution:** The user contacts support. In the meantime, the backend logs include the wallet address, amount charged, and failure reason for manual investigation.

---

### Relayer Out of ETH

**Trigger:** The server wallet (relayer) does not have enough ETH on Ethereum mainnet to pay gas for the `mint()` transaction.

**What the user sees:**
- If the server detects low balance proactively (balance < 0.05 ETH threshold), the **Mint as NFT** button is disabled with a message: "Minting is temporarily unavailable. Please try again later."
- The generate flow still works (it does not require on-chain gas)
- If the server does not detect it in time and the tx fails due to insufficient funds, the user sees the "Mint transaction failed" error from the section above

**Backend behavior:**
- The `/api/mint` endpoint checks the server wallet's ETH balance before attempting the mint
- If below threshold, it returns **503 Service Unavailable** with a JSON body: `{ "error": "Minting temporarily unavailable", "reason": "relayer_low_balance" }`
- The operator is alerted (via logged error) to fund the server wallet

**CV handling:** If the low-balance check happens before CV is charged, no CV is lost. The backend should check balance before charging CV.

**Resolution:** The operator funds the server wallet with ETH. The user can try again later. Their generated image is preserved in their browser session.

---

### User Tries to Generate Without Connecting

**Trigger:** A user types a prompt and tries to click Generate before connecting their wallet.

**What they see:**
- The prompt input field and Generate button are either **not rendered** or **disabled** until the wallet is connected
- If disabled, a tooltip or inline message says: "Connect your wallet to generate a PFP"
- The **Connect Wallet** button is prominently visible

**Resolution:** The user connects their wallet. The generate form becomes active.

---

### Rate Limiting

**Trigger:** A user (or attacker) attempts to spam the generate or mint endpoints.

**Generate rate limit:** Max 5 generates per wallet address per hour.
- On the 6th attempt, the backend returns **429 Too Many Requests**
- The frontend shows: "You have reached the generation limit. Please wait [X minutes] before trying again."
- The rate limit resets hourly and is tracked in-memory on the server (resets on server restart)

**Mint rate limit:** Max 3 mints per wallet address per hour.
- Same behavior as generate rate limiting but with the mint-specific limit
- Frontend message: "You have reached the mint limit. Please try again later."

**What the user sees during rate limiting:**
- The respective button (Generate or Mint) becomes disabled
- A cooldown timer shows when they can try again
- Previously generated images remain visible

**Resolution:** The user waits for the rate limit window to reset.

---

### Mobile Wallet

**Trigger:** A user visits the site on a mobile device.

**Connection flow:**
- The user taps **Connect Wallet**
- RainbowKit shows mobile-optimized options: WalletConnect (opens their mobile wallet app via deep link), Coinbase Wallet, MetaMask mobile, Phantom
- If using WalletConnect: the site opens the user's wallet app, they approve the connection, and are redirected back to the browser

**Signing flow:**
- When the EIP-191 signature is requested, the mobile wallet app opens (or a notification appears) for the user to approve the signature
- The `writeAndOpen` pattern is used: fire the signature request first, then `setTimeout(openWallet, 2000)` to deep-link to the wallet app if it does not open automatically
- After signing, the user returns to the browser where the flow continues

**Layout:**
- The page is fully responsive (1-column layout on mobile)
- The PFP image preview scales to fit the screen width
- Gallery shows 1 column on mobile, 2 on tablet
- All buttons are full-width on mobile for easy tapping

**Known considerations:**
- Mobile browsers may lose React state if the user switches to the wallet app and back. The signature should be re-requested if lost.
- The generated image (base64 data URL in React state) may be lost if the browser reloads. The user must regenerate.

**Resolution:** The mobile flow works end-to-end with deep linking. The user may need to switch between browser and wallet app for each signature.

---

### Already Minted (Returning User)

**Trigger:** A user who has already minted one or more PFPs returns to the site.

**What they see:**
- The generate/mint flow is fully available (users can mint multiple PFPs -- there is no per-wallet limit beyond rate limiting and the 7-day deadline)
- The Gallery page shows all their previously minted PFPs alongside everyone else's
- No special "your PFPs" section exists by default (the gallery shows all PFPs), though the user can identify theirs by the owner address

**After the deadline:**
- The returning user sees the "Collection Frozen" state
- The Gallery is still accessible and shows the complete, permanent collection
- Their PFPs remain on-chain and viewable forever (IPFS-pinned metadata + Ethereum mainnet contract)

---

## UI States

### Home/Generate Page

| State | Condition | What is displayed |
|-------|-----------|-------------------|
| **Disconnected** | No wallet connected | Title, explainer text, Connect Wallet button, countdown timer, Gallery link. Generate form is hidden. |
| **Wrong Network** | Wallet connected but not on Ethereum mainnet | "Switch to Ethereum Mainnet" button. Generate form is hidden. |
| **Connected (Ready)** | Wallet connected on mainnet, deadline not passed | CV balance, prompt input, Generate PFP button with cost, countdown timer. |
| **Insufficient CV (Generate)** | CV balance < generate cost | Generate button disabled, message showing required vs. current balance. |
| **Generating (Loading)** | POST /api/generate in flight | Spinner on Generate button, "Generating your CLAWD..." text, estimated wait time, prompt input locked. |
| **Generate Error** | /api/generate returned an error | Error message with "Try Again" button. Prompt input is re-enabled. |
| **Generated (Preview)** | Image successfully returned | Large PFP image preview, prompt displayed, Mint as NFT button with cost, Generate Again button, updated CV balance. |
| **Insufficient CV (Mint)** | CV balance < mint cost after generating | Mint button disabled, message showing required vs. current balance. Image remains visible. |
| **Minting (Loading)** | POST /api/mint in flight | Multi-step progress indicator (Charging CV, Pinning to IPFS, Minting on Ethereum, Confirming...), Mint button disabled with spinner. |
| **Mint Error** | /api/mint returned an error | Error message with details (deadline passed, low balance, tx failed, rate limited), Retry or Try Again button depending on error type. |
| **Minted (Success)** | Mint completed successfully | PFP image with token ID label, Etherscan tx link, owner address, updated CV balance, "View in Gallery" button, "Generate Another" button. |
| **Frozen (Post-Deadline)** | `block.timestamp > mintDeadline` | "Collection Frozen" banner, generate/mint UI completely removed, "View Gallery" button. Countdown shows "Minting Closed". |
| **Rate Limited** | User exceeded generates/hour or mints/hour | Respective button disabled, cooldown timer showing when the limit resets. |
| **Relayer Unavailable** | Server wallet ETH balance below threshold | Mint button disabled, "Minting temporarily unavailable" message. Generate still works. |

### Gallery Page

| State | Condition | What is displayed |
|-------|-----------|-------------------|
| **Loading** | Events/metadata being fetched | Skeleton cards or spinner in the grid area, "Loading gallery..." text. |
| **Empty** | No PFPs have been minted yet | "No PFPs minted yet. Be the first!" with a link back to the Generate page (if deadline has not passed). |
| **Populated** | One or more PFPs exist | Responsive grid of PFP cards (image, token ID, owner address, prompt), total count header, countdown timer. |
| **Frozen + Populated** | Deadline passed, PFPs exist | Same grid as Populated, but header shows "Collection Frozen -- [N] PFPs minted forever" instead of countdown. No link to generate. |
| **Frozen + Empty** | Deadline passed, no PFPs minted | "The minting window has closed. No PFPs were minted." (Unlikely edge case but handled.) |
| **Error** | RPC/event fetch failed | "Unable to load gallery. Please refresh the page." with a Retry button. |

### Signature Modal (Wallet Popup)

| State | Condition | What is displayed |
|-------|-----------|-------------------|
| **Pending** | Waiting for user to approve/reject in wallet | "Waiting for signature..." text on the page, wallet popup is open. |
| **Approved** | User signed the message | Signature cached, flow continues to the API call. No separate UI state -- transitions immediately. |
| **Rejected** | User rejected the signature | "Signature rejected. You must sign the message to proceed." with a "Try Again" button that re-requests the signature. |

### Countdown Timer

| State | Condition | What is displayed |
|-------|-----------|-------------------|
| **Active (days remaining)** | > 24 hours left | "Xd Yh Zm left to mint" |
| **Active (hours remaining)** | 1-24 hours left | "Xh Ym Zs left to mint" (more urgency in styling -- e.g., orange text) |
| **Active (minutes remaining)** | < 1 hour left | "Xm Ys left to mint" (high urgency -- e.g., red text, pulsing) |
| **Grace period** | < 5 minutes left | "Minting closing soon..." -- new mints are blocked by the backend but the timer still shows time remaining |
| **Expired** | Deadline passed | "Minting Closed" or "Collection Frozen" -- static text, no more ticking |
