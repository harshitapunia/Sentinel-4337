// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import {SentinelPaymaster} from "../src/SentinelPaymaster.sol";
import {IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/ERC4337Utils.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// ─────────────────────────────────────────────────────────────────────────────
// MockEntryPoint
// ─────────────────────────────────────────────────────────────────────────────
// A minimal, fully self-contained EntryPoint that tracks per-account deposits
// and implements every function from IEntryPoint / IEntryPointStake /
// IEntryPointNonces that the paymaster calls or that the test checks.
// ─────────────────────────────────────────────────────────────────────────────
contract MockEntryPoint {
    // ── deposit ledger ─────────────────────────────────────────────────────
    mapping(address => uint256) private _deposits;

    // IEntryPointStake ──────────────────────────────────────────────────────
    function depositTo(address account) external payable {
        _deposits[account] += msg.value;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _deposits[account];
    }

    function withdrawTo(address payable to, uint256 amount) external {
        require(_deposits[msg.sender] >= amount, "MockEP: insufficient deposit");
        _deposits[msg.sender] -= amount;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "MockEP: ETH transfer failed");
    }

    function addStake(uint32) external payable {}
    function unlockStake() external {}
    function withdrawStake(address payable) external {}

    // IEntryPointNonces ─────────────────────────────────────────────────────
    function getNonce(address, uint192) external pure returns (uint256) {
        return 0;
    }

    // IEntryPoint ───────────────────────────────────────────────────────────
    function handleOps(PackedUserOperation[] calldata, address payable) external {}
    function handleAggregatedOps(
        IEntryPoint.UserOpsPerAggregator[] calldata,
        address payable
    ) external {}

    // Allow the mock to receive ETH back during withdrawTo
    receive() external payable {}
}

// ─────────────────────────────────────────────────────────────────────────────
// SentinelPaymasterHarness
// ─────────────────────────────────────────────────────────────────────────────
// Thin wrapper that exposes internal EIP-712 helpers so tests can replicate
// and verify the exact hash the contract computes.
// ─────────────────────────────────────────────────────────────────────────────
contract SentinelPaymasterHarness is SentinelPaymaster {
    constructor(
        IEntryPoint entryPoint_,
        address owner_,
        address signerAddress_
    ) SentinelPaymaster(entryPoint_, owner_, signerAddress_) {}

    /// @dev Exposes the EIP-712 domain separator for test-side verification.
    function exposed_domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @dev Exposes the exact digest the contract signs, allowing tests to
    ///      produce a bit-accurate valid backend signature without replicating
    ///      the internal hash logic manually.
    function exposed_signableHash(
        PackedUserOperation calldata userOp,
        uint48 validAfter_,
        uint48 validUntil_
    ) external view returns (bytes32) {
        return _signableUserOpHash(userOp, validAfter_, validUntil_);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SentinelPaymasterTest
// ─────────────────────────────────────────────────────────────────────────────
contract SentinelPaymasterTest is Test {
    // ── Contracts under test ─────────────────────────────────────────────────
    SentinelPaymasterHarness internal paymaster;
    MockEntryPoint            internal mockEntryPoint;

    // ── Accounts ─────────────────────────────────────────────────────────────
    /// @dev Deterministic, non-trivial private keys (all valid secp256k1 values).
    uint256 internal constant OWNER_PK  = 0xA11CE_B055_1337_DEAD;
    uint256 internal constant SIGNER_PK = 0xB4C4_E3D5_1637_C0DE; // backend server key
    uint256 internal constant RANDOM_PK = 0xDEAD_DEAD_DEAD_DEAD;  // unauthorized key

    address internal owner;
    address internal signerAddress;
    address internal randomUser;

    // ── EIP-712 validity window ───────────────────────────────────────────────
    //
    // IMPORTANT: ERC4337Utils.BLOCK_RANGE_FLAG = 0x800000000000 (top bit of
    // uint48).  PaymasterSigner._validatePaymasterUserOp checks:
    //   (validAfter ^ validUntil) & BLOCK_RANGE_FLAG == 0
    // type(uint48).max = 0xFFFFFFFFFFFF has this bit SET → rangeFlagsCompatible=false
    // → immediate SIG_VALIDATION_FAILED, independent of the signature.
    //
    // Use 0x7FFFFFFFFFFF (≈ year 8.9M AD) — just below the flag threshold.
    uint48  internal constant VALID_AFTER = 0;
    uint48  internal constant VALID_UNTIL = 0x7FFFFFFFFFFF; // BLOCK_RANGE_FLAG clear

    // ─────────────────────────────────────────────────────────────────────────
    // Setup
    // ─────────────────────────────────────────────────────────────────────────

    function setUp() public {
        owner         = vm.addr(OWNER_PK);
        signerAddress = vm.addr(SIGNER_PK);
        randomUser    = makeAddr("randomUser");

        mockEntryPoint = new MockEntryPoint();

        paymaster = new SentinelPaymasterHarness(
            IEntryPoint(address(mockEntryPoint)),
            owner,
            signerAddress
        );

        // Fund test contract and owner with ETH.
        vm.deal(address(this), 100 ether);
        vm.deal(owner, 10 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Sign a 32-byte hash with a given private key → compact r||s||v sig.
    function _sign(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Build a minimal PackedUserOperation where `paymasterAndData` is:
    ///
    ///   paymaster(20) | pmVerGasLimit(16) | pmPostOpGasLimit(16)
    ///   | validAfter(6) | validUntil(6) | paymasterSig_(variable)
    ///
    ///  PaymasterSigner._decodePaymasterUserOp reads paymasterData[0:6]
    ///  as validAfter, [6:12] as validUntil, and [12:] as signature.
    function _buildUserOp(
        address sender_,
        uint48 validAfter_,
        uint48 validUntil_,
        bytes memory paymasterSig_
    ) internal view returns (PackedUserOperation memory) {
        bytes memory paymasterAndData = abi.encodePacked(
            address(paymaster),  // 20 bytes
            uint128(100_000),    // paymasterVerificationGasLimit, 16 bytes
            uint128(50_000),     // paymasterPostOpGasLimit,        16 bytes
            bytes6(validAfter_), // 6 bytes
            bytes6(validUntil_), // 6 bytes
            paymasterSig_        // variable
        );

        return PackedUserOperation({
            sender:             sender_,
            nonce:              0,
            initCode:           bytes(""),
            callData:           bytes(""),
            accountGasLimits:   bytes32(0),
            preVerificationGas: 21_000,
            gasFees:            bytes32(0),
            paymasterAndData:   paymasterAndData,
            signature:          bytes("")
        });
    }

    /// @dev Produces a valid backend ECDSA signature for a userOp by asking
    ///      the contract itself for the exact digest via exposed_signableHash.
    ///
    ///      The signature is computed on the userOp with an EMPTY sig slot,
    ///      which produces the same digest as the userOp with the sig embedded
    ///      because _signableUserOpHash only reads paymasterAndData[20:52]
    ///      (pmVerGasLimit + pmPostOpGasLimit), not the trailing sig bytes.
    function _buildValidSig(
        PackedUserOperation memory userOp,
        uint48 validAfter_,
        uint48 validUntil_,
        uint256 signerPk_
    ) internal view returns (bytes memory) {
        bytes32 digest = paymaster.exposed_signableHash(userOp, validAfter_, validUntil_);
        return _sign(signerPk_, digest);
    }

    /// @dev Pure bytes slice helper.
    function _slice(
        bytes memory data,
        uint256 start,
        uint256 end
    ) internal pure returns (bytes memory) {
        bytes memory result = new bytes(end - start);
        for (uint256 i = 0; i < end - start; i++) {
            result[i] = data[start + i];
        }
        return result;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §1  DEPLOYMENT & INITIALIZATION
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev owner(), entryPoint(), and signer() must exactly match constructor args.
    function test_Constructor_SetsOwnerAndEntryPoint() public view {
        assertEq(paymaster.owner(), owner, "owner() mismatch");
        assertEq(address(paymaster.entryPoint()), address(mockEntryPoint), "entryPoint() mismatch");
        assertEq(paymaster.signer(), signerAddress, "signer() mismatch");
    }

    /// @dev Verify all three addresses are non-zero after construction.
    function test_Constructor_NonZeroAddresses() public view {
        assertTrue(paymaster.owner()               != address(0), "owner is zero");
        assertTrue(address(paymaster.entryPoint()) != address(0), "entryPoint is zero");
        assertTrue(paymaster.signer()              != address(0), "signer is zero");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §2  FUNDING THE ENTRY POINT
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev fundEntryPoint() should credit the paymaster's balance in the
    ///      EntryPoint and emit EntryPointFunded.
    function test_FundEntryPoint_Success() public {
        uint256 fundAmount = 1 ether;

        assertEq(mockEntryPoint.balanceOf(address(paymaster)), 0, "initial deposit should be 0");

        vm.expectEmit(true, false, false, true, address(paymaster));
        emit SentinelPaymaster.EntryPointFunded(address(this), fundAmount);

        paymaster.fundEntryPoint{value: fundAmount}();

        assertEq(
            mockEntryPoint.balanceOf(address(paymaster)),
            fundAmount,
            "EntryPoint deposit balance incorrect after funding"
        );
    }

    /// @dev Multiple successive deposits should accumulate correctly.
    function test_FundEntryPoint_AccumulatesDeposit() public {
        paymaster.fundEntryPoint{value: 1 ether}();
        paymaster.fundEntryPoint{value: 2 ether}();

        assertEq(mockEntryPoint.balanceOf(address(paymaster)), 3 ether, "Accumulated deposit mismatch");
    }

    /// @dev fundEntryPoint with zero ETH should silently credit 0 (no revert).
    function test_FundEntryPoint_ZeroValueNoRevert() public {
        paymaster.fundEntryPoint{value: 0}();
        assertEq(mockEntryPoint.balanceOf(address(paymaster)), 0, "Zero-value fund should leave balance at 0");
    }

    /// @dev Any address (not just owner) can fund the EntryPoint.
    function test_FundEntryPoint_AnyoneCanFund() public {
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 5 ether);

        vm.prank(stranger);
        paymaster.fundEntryPoint{value: 2 ether}();

        assertEq(mockEntryPoint.balanceOf(address(paymaster)), 2 ether, "Stranger funding failed");
    }

    /// @dev Plain ETH sent via receive() stays in the paymaster contract,
    ///      NOT forwarded to the EntryPoint.
    function test_Receive_ETHSentDirectlyStaysInContract() public {
        (bool ok,) = address(paymaster).call{value: 1 ether}("");
        assertTrue(ok, "ETH transfer to paymaster failed");

        assertEq(address(paymaster).balance, 1 ether, "paymaster ETH balance wrong");
        assertEq(mockEntryPoint.balanceOf(address(paymaster)), 0, "direct ETH must NOT fund EntryPoint");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §3  ADMIN WITHDRAWALS
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Owner should be able to withdraw from the EntryPoint deposit.
    function test_WithdrawFromEntryPoint_Success() public {
        paymaster.fundEntryPoint{value: 3 ether}();

        address payable destination = payable(makeAddr("treasury"));

        vm.expectEmit(true, false, false, true, address(paymaster));
        emit SentinelPaymaster.EntryPointWithdrawn(destination, 1 ether);

        vm.prank(owner);
        paymaster.withdrawFromEntryPoint(destination, 1 ether);

        assertEq(mockEntryPoint.balanceOf(address(paymaster)), 2 ether, "EntryPoint deposit not reduced");
        assertEq(destination.balance, 1 ether, "Destination did not receive ETH");
    }

    /// @dev Withdrawing the full balance should leave EntryPoint deposit at 0.
    function test_WithdrawFromEntryPoint_FullWithdrawal() public {
        paymaster.fundEntryPoint{value: 5 ether}();
        address payable destination = payable(makeAddr("safeWallet"));

        vm.prank(owner);
        paymaster.withdrawFromEntryPoint(destination, 5 ether);

        assertEq(mockEntryPoint.balanceOf(address(paymaster)), 0, "Deposit not emptied");
        assertEq(destination.balance, 5 ether, "Destination balance wrong");
    }

    /// @dev Non-owner calling withdrawFromEntryPoint must revert with
    ///      OwnableUnauthorizedAccount.
    function test_WithdrawFromEntryPoint_RevertsIfUnauthorized() public {
        paymaster.fundEntryPoint{value: 1 ether}();

        vm.prank(randomUser);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, randomUser));
        paymaster.withdrawFromEntryPoint(payable(makeAddr("attacker")), 1 ether);
    }

    /// @dev Withdrawal that exceeds deposit should revert from the mock EntryPoint.
    function test_WithdrawFromEntryPoint_RevertsOnInsufficientDeposit() public {
        paymaster.fundEntryPoint{value: 0.5 ether}();

        vm.prank(owner);
        vm.expectRevert(bytes("MockEP: insufficient deposit"));
        paymaster.withdrawFromEntryPoint(payable(makeAddr("treasury")), 1 ether);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §4  SIGNATURE VALIDATION  (validatePaymasterUserOp)
    // ═════════════════════════════════════════════════════════════════════════
    //
    // validatePaymasterUserOp is guarded by `onlyEntryPoint`. All calls MUST
    // use vm.prank(address(mockEntryPoint)).
    //
    // validationData encoding:
    //   • lower 160 bits = aggregator address
    //       address(0) → SIG_VALIDATION_SUCCESS
    //       address(1) → SIG_VALIDATION_FAILED
    //   • bits 160-207 = validUntil
    //   • bits 208-255 = validAfter
    //
    // CRITICAL: BLOCK_RANGE_FLAG = 0x800000000000 (top bit of uint48).
    //   PaymasterSigner checks (validAfter ^ validUntil) & BLOCK_RANGE_FLAG == 0.
    //   Both VALID_AFTER and VALID_UNTIL must have this bit CLEAR.
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev A valid backend ECDSA signature must yield SIG_VALIDATION_SUCCESS.
    ///
    ///      Key insight: _signableUserOpHash reads pmVerGasLimit and pmPostOpGasLimit
    ///      from paymasterAndData[20:52] — NOT the trailing sig bytes. So the hash
    ///      computed from the no-sig userOp equals the hash computed from the
    ///      sig-embedded userOp. We sign the former and verify with the latter.
    function test_ValidatePaymasterUserOp_ValidSignature_ReturnsSuccess() public {
        // Step 1: Build initial userOp with empty sig placeholder.
        address sender = makeAddr("userSender");
        PackedUserOperation memory userOp = _buildUserOp(sender, VALID_AFTER, VALID_UNTIL, bytes(""));

        // Step 2: Get the exact digest the contract will validate against.
        bytes32 digest = paymaster.exposed_signableHash(userOp, VALID_AFTER, VALID_UNTIL);

        // Step 3: Sign with the registered backend key.
        bytes memory sig = _sign(SIGNER_PK, digest);

        // Step 4: Rebuild userOp with the real sig embedded.
        //         The hash is identical because _signableUserOpHash does not
        //         include the trailing sig bytes in paymasterAndData.
        userOp = _buildUserOp(sender, VALID_AFTER, VALID_UNTIL, sig);

        // Step 5: Call validatePaymasterUserOp as the EntryPoint would.
        vm.prank(address(mockEntryPoint));
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0);

        // Step 6: Assert success — aggregator (lower 160 bits) must be address(0).
        assertEq(address(uint160(validationData)), address(0), "Valid sig must return SIG_VALIDATION_SUCCESS");
    }

    /// @dev A wrong-key signature must return SIG_VALIDATION_FAILED.
    function test_ValidatePaymasterUserOp_InvalidSignature_ReturnsFailure() public {
        // Sign with RANDOM_PK (NOT the registered signerAddress).
        bytes memory badSig = _sign(RANDOM_PK, keccak256("garbage hash"));
        PackedUserOperation memory userOp = _buildUserOp(makeAddr("userSender"), VALID_AFTER, VALID_UNTIL, badSig);

        vm.prank(address(mockEntryPoint));
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0);

        assertEq(
            address(uint160(validationData)),
            address(1),
            "Invalid sig must return SIG_VALIDATION_FAILED (aggregator == address(1))"
        );
    }

    /// @dev An entirely empty signature must also return SIG_VALIDATION_FAILED.
    function test_ValidatePaymasterUserOp_EmptySignature_ReturnsFailure() public {
        // Empty paymasterSig → paymasterData < 12 bytes → validAfter=0, validUntil=0, sig=empty.
        PackedUserOperation memory userOp = _buildUserOp(makeAddr("userSender"), VALID_AFTER, VALID_UNTIL, bytes(""));

        vm.prank(address(mockEntryPoint));
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0);

        assertEq(
            address(uint160(validationData)),
            address(1),
            "Empty sig must return SIG_VALIDATION_FAILED"
        );
    }

    /// @dev Calling validatePaymasterUserOp from a non-EntryPoint must revert.
    function test_ValidatePaymasterUserOp_RevertsIfCallerIsNotEntryPoint() public {
        PackedUserOperation memory userOp = _buildUserOp(makeAddr("userSender"), VALID_AFTER, VALID_UNTIL, bytes(""));

        vm.prank(randomUser);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0);
    }

    /// @dev Even the owner is not authorized to call validatePaymasterUserOp
    ///      directly — only the EntryPoint is.
    function test_ValidatePaymasterUserOp_RevertsIfCallerIsOwner() public {
        PackedUserOperation memory userOp = _buildUserOp(makeAddr("userSender"), VALID_AFTER, VALID_UNTIL, bytes(""));

        vm.prank(owner);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0);
    }

    /// @dev A signature from the owner key (not the registered backend signer)
    ///      must be rejected — the paymaster only trusts signerAddress.
    function test_ValidatePaymasterUserOp_OwnerSignatureIsInvalid() public {
        PackedUserOperation memory userOp = _buildUserOp(makeAddr("userSender"), VALID_AFTER, VALID_UNTIL, bytes(""));

        // Sign with OWNER_PK (not SIGNER_PK).
        bytes memory ownerSig = _buildValidSig(userOp, VALID_AFTER, VALID_UNTIL, OWNER_PK);
        userOp = _buildUserOp(makeAddr("userSender"), VALID_AFTER, VALID_UNTIL, ownerSig);

        vm.prank(address(mockEntryPoint));
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(userOp, bytes32(0), 0);

        assertEq(
            address(uint160(validationData)),
            address(1),
            "Owner key must NOT be accepted as the backend signer"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §5  SIGNER ADDRESS INTEGRITY
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Confirm signer() returns exactly the address used at construction.
    function test_Signer_ReturnsRegisteredBackendAddress() public view {
        assertEq(paymaster.signer(), signerAddress, "signer() must match constructor arg");
    }

    /// @dev Confirm signer() is distinct from owner (production setup).
    function test_Signer_IsNotOwner() public view {
        assertTrue(paymaster.signer() != paymaster.owner(), "signer and owner should differ");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // §6  ECDSA SIGNING ROUND-TRIP INTEGRITY
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Verifies the full signing pipeline end-to-end:
    ///        vm.sign(SIGNER_PK, digest) → ECDSA.tryRecover(digest, sig) == signerAddress
    ///      AND that paymaster.signer() agrees with signerAddress.
    ///      This is the foundational invariant tying the test key infrastructure
    ///      to the on-chain contract state.
    function test_ECDSASigningRoundTrip_BackendKeyMatchesContractSigner() public {
        PackedUserOperation memory userOp = _buildUserOp(makeAddr("userSender"), VALID_AFTER, VALID_UNTIL, bytes(""));
        bytes32 digest = paymaster.exposed_signableHash(userOp, VALID_AFTER, VALID_UNTIL);
        bytes memory sig = _sign(SIGNER_PK, digest);

        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, sig);

        assertEq(uint256(err), 0, "ECDSA recovery must succeed (no error)");
        assertEq(recovered, signerAddress, "recovered signer must match signerAddress");
        assertEq(paymaster.signer(), signerAddress, "contract signer() must match signerAddress");
    }
}
