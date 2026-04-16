# ClawdPFP Smart Contract Audit Report

**Contract:** `packages/foundry/contracts/ClawdPFP.sol`
**Auditor:** clawdbotatg (automated audit agent)
**Date:** 2026-04-15
**Solidity Version:** ^0.8.24
**OpenZeppelin Version:** 5.6.1
**Target Chain:** Ethereum Mainnet

---

## Executive Summary

ClawdPFP is a minimal ERC-721 NFT contract with an immutable `minter` address and a time-locked `mintDeadline`. Only the designated minter can call `mint()` before the deadline; after it, minting reverts permanently. There are no admin functions, no owner, no upgrade path, and token URIs are set once at mint time.

The contract is well-written, intentionally minimal, and follows good patterns. OpenZeppelin v5.6.1 ERC721 is used as the base, which provides battle-tested transfer, approval, and safe-mint logic. The audit identified **zero Critical or High findings**. There is **one Medium finding** (missing constructor validation), **two Low findings** (reentrancy ordering concern and misleading event parameter name), and **three Informational findings**.

The test suite covers the key paths (minting, deadline enforcement, access control, sequential IDs, events) and all 10 tests pass.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 0     |
| Medium   | 1     |
| Low      | 2     |
| Info     | 3     |
| **Total** | **6** |

---

## Detailed Findings

### [M-1] Constructor does not validate `_minter` against zero address

**Severity**: Medium
**Category**: evm-audit-access-control
**Location**: `constructor(address _minter, uint256 _mintDuration)` — line 45

**Description**: The constructor does not check that `_minter != address(0)`. If the contract is deployed with `_minter = address(0)`, no address can ever call `mint()` because `msg.sender` cannot be `address(0)` in a normal transaction. The collection would be permanently bricked with no recovery path — there is no owner, no setter, and `minter` is immutable.

**Proof of Concept**:
1. Deploy `ClawdPFP(address(0), 604800)`
2. Any call to `mint()` reverts with `OnlyMinter()` because `msg.sender != address(0)` is always true
3. No recovery — `minter` is immutable, there is no owner to fix it

**Impact**: Permanent loss of the contract deployment (gas costs) and inability to mint any NFTs. Requires a redeployment to recover. While this requires a deployment error, the absence of any recovery mechanism amplifies the impact from Low to Medium.

**Recommendation**: Add a zero-address check in the constructor:
```solidity
error ZeroAddress();

constructor(address _minter, uint256 _mintDuration) ERC721("CLAWD PFP", "CPFP") {
    if (_minter == address(0)) revert ZeroAddress();
    minter = _minter;
    mintDeadline = block.timestamp + _mintDuration;
}
```

---

### [L-1] `_safeMint` callback executes before `_tokenURIs` is set

**Severity**: Low
**Category**: evm-audit-erc721
**Location**: `mint()` — lines 63-66

**Description**: The `mint()` function calls `_safeMint(to, tokenId)` on line 63, which triggers the `onERC721Received` callback on the recipient if it is a contract. Only after `_safeMint` returns does line 64 set `_tokenURIs[tokenId]`. During the callback, `tokenURI(tokenId)` returns an empty string because `_ownerOf(tokenId)` returns the new owner (set during `_safeMint`) but `_tokenURIs[tokenId]` is still empty.

Additionally, the `PFPMinted` event on line 66 is emitted after both `_safeMint` and the URI assignment. During the `onERC721Received` callback, a contract could observe the token existing with no URI and no `PFPMinted` event.

There is no direct fund-loss risk because the callback can only re-enter `mint()` if the recipient is the minter, and each re-entry is a legitimate sequential mint. However, any contract relying on `tokenURI()` during the callback will see stale state.

**Proof of Concept**:
1. Deploy a receiver contract that calls `pfp.tokenURI(tokenId)` inside `onERC721Received`
2. The call returns `""` instead of the intended IPFS URI
3. If the receiver uses this value (e.g., to index metadata), it gets incorrect data

**Recommendation**: Set the token URI before calling `_safeMint`:
```solidity
function mint(address to, string calldata _tokenURI) external {
    if (msg.sender != minter) revert OnlyMinter();
    if (block.timestamp > mintDeadline) revert MintWindowClosed();

    uint256 tokenId = _tokenIdCounter;
    _tokenIdCounter = tokenId + 1;

    _tokenURIs[tokenId] = _tokenURI;     // Set URI first
    _safeMint(to, tokenId);              // Then mint (triggers callback)

    emit PFPMinted(tokenId, to, _tokenURI);
}
```

---

### [L-2] Event parameter `prompt` is misleading — actual value is a token URI

**Severity**: Low
**Category**: evm-audit-general
**Location**: `event PFPMinted` — line 30, `emit PFPMinted` — line 66

**Description**: The `PFPMinted` event declares its third parameter as `string prompt` with the NatSpec comment "The prompt used to generate this PFP." However, the `mint()` function passes `_tokenURI` (the IPFS metadata URI) to this parameter. The value emitted is a token URI like `ipfs://QmHash`, not a generation prompt.

Off-chain indexers, gallery UIs, and analytics tools parsing this event by parameter name will interpret a metadata URI as a generation prompt, leading to incorrect displays or broken parsing.

**Proof of Concept**: An off-chain indexer that reads `event.args.prompt` to display the AI generation prompt will instead display `ipfs://QmTestHash123`.

**Recommendation**: Either:
- (a) Rename the event parameter to `tokenURI` to match what is actually emitted:
  ```solidity
  event PFPMinted(uint256 indexed tokenId, address indexed to, string tokenURI);
  ```
- (b) Add a separate `prompt` parameter to the `mint()` function if the prompt should genuinely be logged on-chain:
  ```solidity
  function mint(address to, string calldata _tokenURI, string calldata _prompt) external { ... }
  event PFPMinted(uint256 indexed tokenId, address indexed to, string tokenURI, string prompt);
  ```

---

### [I-1] No validation on `_mintDuration = 0` in constructor

**Severity**: Info
**Category**: evm-audit-general
**Location**: `constructor` — line 47

**Description**: If `_mintDuration` is 0, `mintDeadline = block.timestamp`, meaning the mint window is restricted to the deployment transaction's block only (since `block.timestamp > mintDeadline` uses strict greater-than). This is almost certainly unintentional but does not create a security vulnerability — it simply makes the collection nearly useless.

**Recommendation**: Consider adding a minimum duration check:
```solidity
error DurationTooShort();

if (_mintDuration < 1 hours) revert DurationTooShort();
```

---

### [I-2] Gas optimization: per-token URI storage is expensive for uniform base URIs

**Severity**: Info
**Category**: evm-audit-general
**Location**: `mapping(uint256 => string) private _tokenURIs` — line 24

**Description**: Each minted token stores a complete IPFS URI string in a separate storage slot. For a collection where all URIs share a common prefix (e.g., `ipfs://QmBaseHash/`), this duplicates the prefix across every token, costing approximately 20,000+ gas in storage per token beyond what a base-URI + token-ID approach would cost.

For a PFP collection where each token has a unique CID, per-token storage is the correct approach. This is informational only and the current design is appropriate for unique-CID-per-token metadata.

**Recommendation**: No change needed. If the collection grows large and all URIs share a common gateway prefix, consider implementing `_baseURI()` to reduce per-token storage costs.

---

### [I-3] `mintDeadline` overflow theoretically possible for very large `_mintDuration`

**Severity**: Info
**Category**: evm-audit-precision-math
**Location**: `constructor` — line 47: `mintDeadline = block.timestamp + _mintDuration`

**Description**: If `_mintDuration` is close to `type(uint256).max`, the addition `block.timestamp + _mintDuration` would revert due to Solidity 0.8+ overflow protection. This is self-correcting (the deployment would fail), so there is no exploit. However, a very large but non-overflowing `_mintDuration` (e.g., `type(uint256).max - block.timestamp`) would create a deadline so far in the future it's effectively permanent minting — which contradicts the "frozen forever" design intent.

**Recommendation**: Consider an upper bound on `_mintDuration` (e.g., 365 days) to enforce the design intent that minting is temporary.

---

## Checklist Walkthrough

### Access Control
- [x] `minter` is immutable — cannot be changed after deployment
- [x] `OnlyMinter()` check is the first check in `mint()` — correct ordering
- [x] No owner, no admin, no upgrade path — minimal trust model
- [x] No `selfdestruct` or `delegatecall`
- [ ] **Zero-address check on minter** — MISSING (see M-1)

### Time-Based Logic
- [x] `block.timestamp > mintDeadline` — uses strict greater-than, so minting at exactly the deadline is allowed
- [x] Test `testMintRevertsExactlyAtDeadline` confirms this is intentional
- [x] `mintDeadline` is immutable — cannot be extended
- [x] No time manipulation risk beyond standard validator ~12s window (acceptable for a 7-day window)

### ERC-721 Compliance
- [x] Inherits OZ v5.6.1 ERC721 — full standard compliance
- [x] `tokenURI()` correctly overrides base implementation with per-token URIs
- [x] `_ownerOf(tokenId) == address(0)` check for nonexistent tokens is correct
- [x] `_safeMint` used (not `_mint`) — calls `onERC721Received` for contract recipients
- [x] Standard Transfer, Approval events emitted by OZ base
- [x] `supportsInterface` inherited from OZ — returns true for ERC721 and ERC165

### Reentrancy
- [x] `_safeMint` creates a callback vector, but the only state at risk is tokenURI being empty during callback (see L-1)
- [x] Re-entering `mint()` from callback requires being the minter — legitimate use
- [x] No ETH held by contract, no token transfers, no value at risk during callback
- [x] Token counter uses checked arithmetic (Solidity 0.8+)

### Token ID Sequence
- [x] Sequential from 0, no gaps possible (counter incremented by 1 each mint)
- [x] `uint256` counter — overflow at 2^256, practically impossible
- [x] No ability to mint specific token IDs — always auto-incrementing

### Deploy Script
- [x] Sets `deployer` as `minter` — appropriate for a relayer pattern
- [x] `604800` seconds = 7 days — correct constant
- [x] Uses SE2's `ScaffoldEthDeployerRunner` modifier for proper broadcast handling
- [x] ABI export handled by SE2's `generateTsAbis.js` from broadcast artifacts — no `deployments.push` needed

### Compiler & Chain
- [x] Solidity ^0.8.24 — `PUSH0` opcode emitted. Contract targets Ethereum mainnet where `PUSH0` is supported (Shanghai+). No L2 compatibility issue.
- [x] No inline assembly
- [x] No `unchecked` blocks in user code (OZ uses them internally for balance tracking, which is safe)

---

## Test Coverage Assessment

The test suite (`ClawdPFP.t.sol`) covers:
- Constructor state initialization
- Minting before deadline (happy path)
- Minting after deadline (revert)
- Minting at exact deadline (boundary, passes)
- Non-minter revert
- Token URI correctness (multiple tokens)
- Token URI revert for nonexistent token
- Event emission verification
- Sequential token IDs
- Multiple mints to same user

**Missing test coverage:**
- Minting to `address(0)` (handled by OZ, but good to have explicit test)
- Minting to a contract that reverts in `onERC721Received`
- Minting to a contract that re-enters `mint()` during `onERC721Received`
- Constructor with `_minter = address(0)` — verify bricked state
- Constructor with `_mintDuration = 0` — verify behavior
- Token transfer, approval, and safe-transfer flows (covered by OZ tests, but integration tests are good practice)
- Empty string `_tokenURI` — verify behavior

---

## Conclusion

ClawdPFP is a well-designed, intentionally minimal ERC-721 contract. The immutable minter + deadline pattern effectively creates a "mint and freeze" collection with no admin risk. The single Medium finding (missing zero-address validation in constructor) should be addressed before mainnet deployment, as it could permanently brick the contract with no recovery path. The two Low findings are improvements that would make the contract more robust but are not blocking.

The contract is **suitable for mainnet deployment** after addressing M-1.
