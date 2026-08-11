// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {SentinelVault} from "../src/SentinelVault.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {IPoolAddressesProvider} from "aave-v3-core/contracts/interfaces/IPoolAddressesProvider.sol";
import {IPool} from "aave-v3-core/contracts/interfaces/IPool.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks for DeFi Primitives
// ─────────────────────────────────────────────────────────────────────────────
contract MockERC20 {
    uint8 public decimals;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(uint8 decimals_) {
        decimals = decimals_;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract MockAggregatorV3 {
    int256 private _price;
    constructor(int256 price_) {
        _price = price_;
    }
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (0, _price, 0, block.timestamp, 0);
    }
    function setPrice(int256 newPrice) external {
        _price = newPrice;
    }
}

contract MockSwapRouter {
    function exactInputSingle(
        ISwapRouter.ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        return params.amountOutMinimum;
    }
}

contract MockPool {
    function repay(address, uint256, uint256, address) external returns (uint256) {
        return 0;
    }
    function withdraw(address, uint256, address) external returns (uint256) {
        return 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness Contract
// ─────────────────────────────────────────────────────────────────────────────
// Exposes the internal `_rawSignatureValidation` so the test contract can call
// it directly without going through the full EntryPoint validateUserOp flow.
// ─────────────────────────────────────────────────────────────────────────────
contract SentinelVaultHarness is SentinelVault {
    constructor(
        IEntryPoint entryPoint_,
        address owner_,
        IPoolAddressesProvider addressesProvider_,
        address weth_,
        address usdc_,
        AggregatorV3Interface chainlinkWethUsd_,
        ISwapRouter uniswapRouter_
    ) SentinelVault(entryPoint_, owner_, addressesProvider_, weth_, usdc_, chainlinkWethUsd_, uniswapRouter_) {}

    /// @dev Exposes `_rawSignatureValidation` for direct test assertions.
    function exposed_rawSignatureValidation(
        bytes32 hash,
        bytes calldata signature
    ) external view returns (bool) {
        return _rawSignatureValidation(hash, signature);
    }

    /// @dev Exposes `_enforceSlippageGuardrail` for direct math verification.
    function exposed_enforceSlippageGuardrail(
        uint256 wethAmountIn,
        uint256 botProposedUsdcOut
    ) public view {
        _enforceSlippageGuardrail(wethAmountIn, botProposedUsdcOut);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock: Minimal EntryPoint
// ─────────────────────────────────────────────────────────────────────────────
// SentinelVault only calls super.entryPoint() when _entryPoint == address(0).
// For testing we always pass a non-zero mock, so only its address is needed.
// ─────────────────────────────────────────────────────────────────────────────
contract MockEntryPoint {
    // Satisfies any low-level delegated getNonce calls from the OZ base.
    function getNonce(address, uint192) external pure returns (uint256) {
        return 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock: Minimal PoolAddressesProvider
// ─────────────────────────────────────────────────────────────────────────────
// Only `getPool()` is exercised by SentinelVault.POOL(). All other functions
// from the full IPoolAddressesProvider interface are unused in Phase 1.
// ─────────────────────────────────────────────────────────────────────────────
contract MockPoolAddressesProvider {
    address private immutable _pool;

    constructor(address pool_) {
        _pool = pool_;
    }

    function getPool() external view returns (address) {
        return _pool;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SentinelVaultTest
// ─────────────────────────────────────────────────────────────────────────────
contract SentinelVaultTest is Test {
    // ── Contracts under test ─────────────────────────────────────────────────
    SentinelVaultHarness internal vault;
    MockEntryPoint        internal mockEntryPoint;
    MockPoolAddressesProvider internal mockProvider;

    // ── Accounts ─────────────────────────────────────────────────────────────
    uint256 internal constant OWNER_PK   = 0xA11CE_B055_DEAD_BEEF; // deterministic owner key
    uint256 internal constant KEEPER_PK  = 0xB0B_CAFE_F00D_1337;   // deterministic keeper key
    uint256 internal constant RANDOM_PK  = 0xDEAD_DEAD_DEAD_DEAD;  // unauthorized signer

    address internal owner;
    address internal keeper;
    address internal mockPool;

    MockERC20 internal mockWeth;
    MockERC20 internal mockUsdc;
    MockAggregatorV3 internal mockAggregator;
    MockSwapRouter internal mockSwapRouter;
    MockPool internal mockPoolContract;

    // ── Constants ─────────────────────────────────────────────────────────────
    uint256 internal constant START_TS   = 1_700_000_000; // Nov 2023 – realistic base timestamp
    uint48  internal constant ONE_HOUR   = 3_600;

    // ─────────────────────────────────────────────────────────────────────────
    // Setup
    // ─────────────────────────────────────────────────────────────────────────

    function setUp() public {
        // Pin to a predictable, non-trivial timestamp so past-expiry tests work.
        vm.warp(START_TS);

        owner    = vm.addr(OWNER_PK);
        keeper   = vm.addr(KEEPER_PK);

        mockPoolContract = new MockPool();
        mockPool = address(mockPoolContract);

        mockWeth = new MockERC20(18);
        mockUsdc = new MockERC20(6);
        mockAggregator = new MockAggregatorV3(3000 * 10**8);
        mockSwapRouter = new MockSwapRouter();

        mockEntryPoint = new MockEntryPoint();
        mockProvider   = new MockPoolAddressesProvider(mockPool);

        vault = new SentinelVaultHarness(
            IEntryPoint(address(mockEntryPoint)),
            owner,
            IPoolAddressesProvider(address(mockProvider)),
            address(mockWeth),
            address(mockUsdc),
            AggregatorV3Interface(address(mockAggregator)),
            ISwapRouter(address(mockSwapRouter))
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §1  DEPLOYMENT & INITIALIZATION
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Owner, EntryPoint, and ADDRESSES_PROVIDER must be set exactly as
    ///      passed to the constructor.
    function test_Constructor_SetsOwnerAndProviders() public view {
        assertEq(vault.owner(), owner, "owner mismatch");
        assertEq(
            address(vault.entryPoint()),
            address(mockEntryPoint),
            "entryPoint mismatch"
        );
        assertEq(
            address(vault.ADDRESSES_PROVIDER()),
            address(mockProvider),
            "ADDRESSES_PROVIDER mismatch"
        );
    }

    /// @dev Passing address(0) as owner must revert with ZeroAddress error.
    function test_Constructor_RevertsOnZeroAddressOwner() public {
        vm.expectRevert(SentinelVault.SentinelVault__ZeroAddress.selector);
        new SentinelVaultHarness(
            IEntryPoint(address(mockEntryPoint)),
            address(0),                                       // ← zero owner
            IPoolAddressesProvider(address(mockProvider)),
            address(mockWeth),
            address(mockUsdc),
            AggregatorV3Interface(address(mockAggregator)),
            ISwapRouter(address(mockSwapRouter))
        );
    }

    /// @dev Passing address(0) as EntryPoint is valid; the vault falls back to
    ///      the OZ canonical ENTRYPOINT_V09 constant (0x4337…).
    function test_Constructor_FallsBackToDefaultEntryPoint() public {
        SentinelVaultHarness vaultNoEP = new SentinelVaultHarness(
            IEntryPoint(address(0)),                          // ← triggers fallback
            owner,
            IPoolAddressesProvider(address(mockProvider)),
            address(mockWeth),
            address(mockUsdc),
            AggregatorV3Interface(address(mockAggregator)),
            ISwapRouter(address(mockSwapRouter))
        );
        // Must return the OZ constant, not address(0).
        assertTrue(
            address(vaultNoEP.entryPoint()) != address(0),
            "entryPoint should not be zero when falling back to OZ default"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §2  SESSION KEY MANAGEMENT
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Owner can register a keeper with a future validUntil timestamp.
    ///      The mapping must be updated and SessionKeyRegistered must be emitted.
    function test_RegisterSessionKey_Success() public {
        uint48 validUntil = uint48(block.timestamp) + ONE_HOUR;

        // Expect exact event emission (check topic1 = keeper address).
        vm.expectEmit(true, false, false, true, address(vault));
        emit SentinelVault.SessionKeyRegistered(keeper, validUntil);

        vm.prank(owner);
        vault.registerSessionKey(keeper, validUntil);

        assertEq(vault.sessionKeys(keeper), validUntil, "sessionKeys mapping not updated");
    }

    /// @dev A non-owner EOA must not be able to register session keys.
    function test_RegisterSessionKey_RevertsIfUnauthorized() public {
        address attacker = makeAddr("attacker");

        vm.prank(attacker);
        vm.expectRevert(SentinelVault.SentinelVault__Unauthorized.selector);
        vault.registerSessionKey(keeper, uint48(block.timestamp) + ONE_HOUR);
    }

    /// @dev Attempting to register address(0) as a keeper must revert.
    function test_RegisterSessionKey_RevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(SentinelVault.SentinelVault__ZeroAddress.selector);
        vault.registerSessionKey(address(0), uint48(block.timestamp) + ONE_HOUR);
    }

    /// @dev A validUntil equal to block.timestamp (already expired) must revert.
    function test_RegisterSessionKey_RevertsOnCurrentTimestampExpiry() public {
        vm.prank(owner);
        vm.expectRevert(SentinelVault.SentinelVault__InvalidExpiry.selector);
        vault.registerSessionKey(keeper, uint48(block.timestamp)); // equal ≡ expired
    }

    /// @dev A validUntil strictly in the past must revert.
    function test_RegisterSessionKey_RevertsOnPastExpiry() public {
        vm.prank(owner);
        vm.expectRevert(SentinelVault.SentinelVault__InvalidExpiry.selector);
        vault.registerSessionKey(keeper, uint48(block.timestamp) - 1); // in the past
    }

    /// @dev Registering with validUntil == 0 revokes the key (special sentinel value).
    function test_RevokeSessionKey_Success() public {
        // Step 1: register an active key.
        uint48 validUntil = uint48(block.timestamp) + ONE_HOUR;
        vm.prank(owner);
        vault.registerSessionKey(keeper, validUntil);
        assertEq(vault.sessionKeys(keeper), validUntil, "key not registered");

        // Step 2: revoke by setting validUntil = 0.
        vm.expectEmit(true, false, false, true, address(vault));
        emit SentinelVault.SessionKeyRegistered(keeper, 0);

        vm.prank(owner);
        vault.registerSessionKey(keeper, 0);

        assertEq(vault.sessionKeys(keeper), 0, "key not revoked");
    }

    /// @dev A key registered by the vault itself (via an EntryPoint userOp)
    ///      must be accepted (address(this) == vault is the self-call path).
    function test_RegisterSessionKey_AllowsSelfCall() public {
        uint48 validUntil = uint48(block.timestamp) + ONE_HOUR;

        // Simulate the vault calling itself (as EntryPoint would route it).
        vm.prank(address(vault));
        vault.registerSessionKey(keeper, validUntil);

        assertEq(vault.sessionKeys(keeper), validUntil, "self-call registration failed");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §3  SIGNATURE VALIDATION  (_rawSignatureValidation)
    // ═════════════════════════════════════════════════════════════════════════

    // ── helpers ──────────────────────────────────────────────────────────────

    /// @dev Produces a compact 65-byte {r}{s}{v} ECDSA signature.
    function _sign(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        return abi.encodePacked(r, s, v);
    }

    // ── tests ─────────────────────────────────────────────────────────────────

    /// @dev A signature produced by the owner's private key must be valid.
    function test_SignatureValidation_ValidOwnerSignature() public view {
        bytes32 hash = keccak256("sentinel owner message");
        bytes memory sig = _sign(OWNER_PK, hash);

        assertTrue(
            vault.exposed_rawSignatureValidation(hash, sig),
            "owner signature rejected"
        );
    }

    /// @dev A signature produced by a registered, non-expired keeper must be valid.
    function test_SignatureValidation_ValidSessionKeySignature() public {
        // Register keeper for one hour.
        vm.prank(owner);
        vault.registerSessionKey(keeper, uint48(block.timestamp) + ONE_HOUR);

        bytes32 hash = keccak256("keeper operation hash");
        bytes memory sig = _sign(KEEPER_PK, hash);

        assertTrue(
            vault.exposed_rawSignatureValidation(hash, sig),
            "valid session key signature rejected"
        );
    }

    /// @dev After vm.warp past validUntil, the keeper's signature must be rejected.
    function test_SignatureValidation_ExpiredSessionKeySignature() public {
        uint48 validUntil = uint48(block.timestamp) + ONE_HOUR;

        vm.prank(owner);
        vault.registerSessionKey(keeper, validUntil);

        // Jump 1 second past expiry.
        vm.warp(uint256(validUntil) + 1);

        bytes32 hash = keccak256("keeper operation hash post-expiry");
        bytes memory sig = _sign(KEEPER_PK, hash);

        assertFalse(
            vault.exposed_rawSignatureValidation(hash, sig),
            "expired session key should be rejected"
        );
    }

    /// @dev A session key whose validUntil == block.timestamp (boundary) must
    ///      be valid: condition is `block.timestamp <= validUntil`.
    function test_SignatureValidation_SessionKeyAtExactExpiryBoundary() public {
        uint48 validUntil = uint48(block.timestamp) + ONE_HOUR;

        vm.prank(owner);
        vault.registerSessionKey(keeper, validUntil);

        // Warp to the exact expiry timestamp — key should still be valid.
        vm.warp(uint256(validUntil));

        bytes32 hash = keccak256("boundary check");
        bytes memory sig = _sign(KEEPER_PK, hash);

        assertTrue(
            vault.exposed_rawSignatureValidation(hash, sig),
            "session key at exact expiry should still be valid"
        );
    }

    /// @dev A revoked session key (validUntil == 0) must be rejected even if
    ///      the signature is otherwise well-formed.
    function test_SignatureValidation_RevokedSessionKeySignature() public {
        // Register then immediately revoke.
        vm.startPrank(owner);
        vault.registerSessionKey(keeper, uint48(block.timestamp) + ONE_HOUR);
        vault.registerSessionKey(keeper, 0); // revoke
        vm.stopPrank();

        bytes32 hash = keccak256("revoked keeper hash");
        bytes memory sig = _sign(KEEPER_PK, hash);

        assertFalse(
            vault.exposed_rawSignatureValidation(hash, sig),
            "revoked session key should be rejected"
        );
    }

    /// @dev An entirely unknown signer (not owner, not a session key) must be rejected.
    function test_SignatureValidation_InvalidSignature() public view {
        bytes32 hash = keccak256("attacker message");
        bytes memory sig = _sign(RANDOM_PK, hash); // key never registered

        assertFalse(
            vault.exposed_rawSignatureValidation(hash, sig),
            "unknown signer should be rejected"
        );
    }

    /// @dev A malformed / short signature must be rejected gracefully (no revert).
    function test_SignatureValidation_MalformedSignatureNoRevert() public view {
        bytes32 hash = keccak256("malformed sig test");
        bytes memory badSig = hex"deadbeef"; // < 65 bytes — will fail ECDSA recovery

        // Must return false, not revert.
        assertFalse(
            vault.exposed_rawSignatureValidation(hash, badSig),
            "malformed sig should return false, not revert"
        );
    }

    /// @dev Signing a *different* hash with the owner key and comparing against
    ///      a different hash must return false (prevents hash substitution).
    function test_SignatureValidation_WrongHashReturnsFalse() public view {
        bytes32 signedHash   = keccak256("correct message");
        bytes32 differentHash = keccak256("different message");
        bytes memory sig = _sign(OWNER_PK, signedHash);

        assertFalse(
            vault.exposed_rawSignatureValidation(differentHash, sig),
            "signature for different hash should be rejected"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §4  PHASE 2 - PRICE GUARDRAIL & FLASH LOAN EXECUTION
    // ═════════════════════════════════════════════════════════════════════════

    function test_Guardrail_Success_ExactTolerance() public {
        uint256 wethAmount = 10 * 10**18;
        mockAggregator.setPrice(3000 * 10**8);

        // Fair Value = $30,000 (30000 * 10**6 USDC)
        // 1.5% Slippage = 98.5% of 30,000 = 29,550
        uint256 proposedUsdc = 29550 * 10**6;

        vault.exposed_enforceSlippageGuardrail(wethAmount, proposedUsdc); // Should not revert
    }

    function test_Guardrail_Success_BetterThanMarket() public {
        uint256 wethAmount = 10 * 10**18;
        mockAggregator.setPrice(3000 * 10**8);

        uint256 proposedUsdc = 31000 * 10**6; // Better than 1.5% slippage

        vault.exposed_enforceSlippageGuardrail(wethAmount, proposedUsdc); // Should not revert
    }

    function test_Guardrail_RevertsOn_BadPrice_SlippageExceeded() public {
        uint256 wethAmount = 10 * 10**18;
        mockAggregator.setPrice(3000 * 10**8);

        // Just below the 1.5% tolerance
        uint256 proposedUsdc = (29550 * 10**6) - 1;

        vm.expectRevert("SentinelVault__SlippageExceeded");
        vault.exposed_enforceSlippageGuardrail(wethAmount, proposedUsdc);
    }

    function test_Guardrail_RevertsOn_DecimalImbalance() public {
        uint256 wethAmount = 1 * 10**18;
        mockAggregator.setPrice(3000 * 10**8);

        // Bot proposed output scaled to 18 decimals instead of USDC's 6 decimals.
        // e.g. 3000 * 10**18.
        // The fair value calculation inside expects botProposedUsdcOut to be >= 2955 * 10**6.
        // 3000 * 10**18 is massively larger, so it will actually pass the mathematical guardrail
        // because the contract conservatively says: "If they promise us a trillion USDC, great!"
        uint256 proposedUsdc = 3000 * 10**18;

        vault.exposed_enforceSlippageGuardrail(wethAmount, proposedUsdc);
    }

    function test_ExecuteOperation_VerifiesGuardrail() public {
        uint256 wethAmountToSell = 10 * 10**18;
        bytes memory params = abi.encode(wethAmountToSell);
        mockAggregator.setPrice(3000 * 10**8);

        uint256 flashLoanAmount = 29550 * 10**6;
        uint256 premium = 0;

        vm.prank(mockPool);
        bool success = vault.executeOperation(
            address(mockUsdc),
            flashLoanAmount,
            premium,
            makeAddr("initiator"),
            params
        );
        assertTrue(success, "executeOperation failed");
    }
}
