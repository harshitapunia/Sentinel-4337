// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─── OpenZeppelin Paymaster Infrastructure ────────────────────────────────────
import {PaymasterSigner} from
    "@openzeppelin/contracts/account/paymaster/extensions/PaymasterSigner.sol";
import {SignerECDSA} from
    "@openzeppelin/contracts/utils/cryptography/signers/SignerECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/IERC4337.sol";

/**
 * @title  SentinelPaymaster
 * @author Sentinel-4337 Protocol
 * @notice ERC-4337 Paymaster that sponsors gas fees on behalf of users whose
 *         operations carry a valid backend ECDSA signature.
 *
 * @dev    Inherits:
 *           • PaymasterSigner  — EIP-712 typed-data signature validation wired
 *                                into the ERC-4337 paymaster flow.
 *           • SignerECDSA      — concrete ECDSA `_rawSignatureValidation` that
 *                                checks the recovered address against `_signer`.
 *           • Ownable          — single-owner access control for admin ops.
 *
 *         The backend Node.js server holds the private key matching
 *         `signerAddress_`.  Before approving a userOp it signs the
 *         EIP-712 `UserOperationRequest` struct produced by PaymasterSigner.
 *         The EntryPoint calls `validatePaymasterUserOp`, which in turn calls
 *         `_validatePaymasterUserOp` from PaymasterSigner, recovering the
 *         signer and confirming it matches the registered backend address.
 *
 *         Gas Funding Flow:
 *           Owner/deployer script ──ETH──► fundEntryPoint()
 *                                              │
 *                                              ▼
 *                              EntryPoint.depositTo(address(this))
 *                                              │
 *                                    (gas balance credited)
 *                                              │
 *                           EntryPoint deducts gas per sponsored userOp
 *
 *         Recovery Flow:
 *           Owner ──► withdrawFromEntryPoint(destination, amount)
 *                           │
 *                           ▼
 *                     EntryPoint.withdrawTo(destination, amount)
 */
contract SentinelPaymaster is PaymasterSigner, SignerECDSA, Ownable {
    // ─── State ────────────────────────────────────────────────────────────────

    /// @dev Custom EntryPoint instance supplied at construction time.
    IEntryPoint private immutable _entryPoint;

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @dev Emitted when ETH is deposited into the EntryPoint gas pool.
    event EntryPointFunded(address indexed sender, uint256 amount);

    /// @dev Emitted when the owner withdraws ETH from the EntryPoint gas pool.
    event EntryPointWithdrawn(address indexed destination, uint256 amount);

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param entryPoint_     The canonical ERC-4337 EntryPoint contract.
     * @param owner_          Protocol admin; can fund & withdraw gas balance.
     * @param signerAddress_  Backend Node.js server address whose ECDSA
     *                        signatures authorize free-gas sponsorship.
     */
    constructor(
        IEntryPoint entryPoint_,
        address owner_,
        address signerAddress_
    )
        PaymasterSigner()
        EIP712("SentinelPaymaster", "1")
        Ownable(owner_)
        SignerECDSA(signerAddress_)
    {
        _entryPoint = entryPoint_;
    }

    // ─── EntryPoint Override ──────────────────────────────────────────────────

    /**
     * @notice Returns the ERC-4337 EntryPoint for this paymaster.
     * @dev    Overrides the default `ENTRYPOINT_V09` constant from the base
     *         `Paymaster` contract so that a custom EntryPoint can be used
     *         (e.g., a local Anvil/Hardhat deployment for testing).
     */
    function entryPoint() public view virtual override returns (IEntryPoint) {
        return _entryPoint;
    }

    // ─── Gas Funding ──────────────────────────────────────────────────────────

    /**
     * @notice Deposits the sent ETH into the EntryPoint to credit this
     *         paymaster's gas balance.
     *
     * @dev    Anyone may call this to top up the gas pool (owner, deployer
     *         scripts, or public contributors).  The EntryPoint maps the
     *         deposit to `address(this)` and deducts from it each time this
     *         paymaster sponsors a userOp.
     *
     *         Emits {EntryPointFunded}.
     */
    function fundEntryPoint() external payable {
        entryPoint().depositTo{value: msg.value}(address(this));
        emit EntryPointFunded(msg.sender, msg.value);
    }

    // ─── Admin Withdrawal ─────────────────────────────────────────────────────

    /**
     * @notice Withdraws `amount` ETH from this paymaster's EntryPoint deposit
     *         to `destination`.
     *
     * @dev    Only callable by the owner.  Used to recover unused gas funds
     *         or to rebalance across paymasters.
     *
     *         Emits {EntryPointWithdrawn}.
     *
     * @param destination  Recipient of the withdrawn ETH.
     * @param amount       Wei to withdraw from the EntryPoint deposit.
     */
    function withdrawFromEntryPoint(
        address payable destination,
        uint256 amount
    ) external onlyOwner {
        entryPoint().withdrawTo(destination, amount);
        emit EntryPointWithdrawn(destination, amount);
    }

    // ─── Receive ETH ──────────────────────────────────────────────────────────

    /**
     * @notice Allows the contract to receive plain ETH transfers.
     * @dev    ETH sent directly to the contract is held here; use
     *         `fundEntryPoint()` to credit it to the EntryPoint gas pool.
     */
    receive() external payable {}
}
