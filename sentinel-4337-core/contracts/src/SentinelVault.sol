// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─── OpenZeppelin ERC-4337 / ERC-7579 Base ────────────────────────────────────
import {AccountERC7579Hooked} from
    "@openzeppelin/contracts/account/extensions/draft-AccountERC7579Hooked.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ─── Aave V3 Flash Loan Interface ─────────────────────────────────────────────
import {IFlashLoanSimpleReceiver} from
    "aave-v3-core/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {IPoolAddressesProvider} from
    "aave-v3-core/contracts/interfaces/IPoolAddressesProvider.sol";
import {IPool} from "aave-v3-core/contracts/interfaces/IPool.sol";

// ─── Price Guardrail & Swap Interfaces ────────────────────────────────────────
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title  SentinelVault
 * @author Sentinel-4337 Protocol
 * @notice Programmable smart-account vault combining:
 *         • ERC-4337 Account Abstraction (EntryPoint v0.9)
 *         • ERC-7579 module system with hook support
 *         • Session Key authorization for keeper bots
 *         • Aave V3 Flash Loan receiver stub (logic injected Phase 2)
 *
 * @dev    Inherits AccountERC7579Hooked which provides the full ERC-7579
 *         module lifecycle (validators, executors, hooks) on top of the
 *         ERC-4337 Account base.  The only abstract function callers must
 *         satisfy is `_rawSignatureValidation`, implemented below using
 *         ECDSA with an owner + session-key dual-path.
 */
contract SentinelVault is AccountERC7579Hooked, IFlashLoanSimpleReceiver {
    using ECDSA for bytes32;

    // ─── Errors ───────────────────────────────────────────────────────────────

    /// @dev Caller is not the owner or the account itself (via EntryPoint).
    error SentinelVault__Unauthorized();

    /// @dev Provided keeper address is the zero address.
    error SentinelVault__ZeroAddress();

    /// @dev Session key expiry is already in the past.
    error SentinelVault__InvalidExpiry();

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @dev Emitted when a session key is registered or revoked.
    event SessionKeyRegistered(address indexed keeper, uint48 validUntil);

    // ─── State ────────────────────────────────────────────────────────────────

    /// @dev The single owner / primary signer of this vault.
    address public immutable owner;

    /// @dev Custom EntryPoint override (set in constructor; falls back to v0.9
    ///      default if address(0) is passed).
    IEntryPoint private immutable _entryPoint;

    /**
     * @notice Maps a keeper-bot address to its session-key expiry timestamp.
     * @dev    A value of 0 means the session key is not registered.
     *         A registered key is valid while `block.timestamp <= sessionKeys[keeper]`.
     */
    mapping(address keeper => uint48 validUntil) public sessionKeys;

    // ─── Aave Integration State ───────────────────────────────────────────────

    /// @dev Aave V3 addresses provider — injected in constructor, read-only.
    IPoolAddressesProvider private immutable _addressesProvider;

    // ─── Guardrail & Swap State ───────────────────────────────────────────────

    address public immutable weth;
    address public immutable usdc;
    AggregatorV3Interface public immutable chainlinkWethUsd;
    ISwapRouter public immutable uniswapRouter;

    // ─── Constructor ──────────────────────────────────────────────────────────

    /**
     * @param entryPoint_         The ERC-4337 EntryPoint contract address.
     *                            Pass `address(0)` to use the canonical v0.9
     *                            deployment (0x433709…).
     * @param owner_              The primary signer / owner of this vault.
     * @param addressesProvider_  Aave V3 PoolAddressesProvider for this network.
     *                            Pass `address(0)` during testing / local dev.
     * @param weth_               Address of WETH token.
     * @param usdc_               Address of USDC token.
     * @param chainlinkWethUsd_   Chainlink Aggregator for ETH/USD.
     * @param uniswapRouter_      Uniswap V3 SwapRouter address.
     */
    constructor(
        IEntryPoint entryPoint_,
        address owner_,
        IPoolAddressesProvider addressesProvider_,
        address weth_,
        address usdc_,
        AggregatorV3Interface chainlinkWethUsd_,
        ISwapRouter uniswapRouter_
    ) {
        if (owner_ == address(0)) revert SentinelVault__ZeroAddress();

        owner = owner_;
        _addressesProvider = addressesProvider_;
        weth = weth_;
        usdc = usdc_;
        chainlinkWethUsd = chainlinkWethUsd_;
        uniswapRouter = uniswapRouter_;

        // If a custom EntryPoint is supplied use it; otherwise the base
        // `entryPoint()` function returns the OZ constant ENTRYPOINT_V09.
        _entryPoint = entryPoint_;
    }

    // ─── ERC-4337 EntryPoint Override ─────────────────────────────────────────

    /**
     * @notice Returns the ERC-4337 EntryPoint for this account.
     * @dev    Returns the custom EntryPoint supplied in the constructor, or
     *         the OZ default ENTRYPOINT_V09 (0x4337…) if none was provided.
     */
    function entryPoint() public view virtual override returns (IEntryPoint) {
        if (address(_entryPoint) != address(0)) {
            return _entryPoint;
        }
        return super.entryPoint();
    }

    // ─── Session Key Management ───────────────────────────────────────────────

    /**
     * @notice Registers (or revokes) a keeper-bot session key.
     * @dev    Only callable by the owner or by the vault itself (i.e. via an
     *         EntryPoint userOp that passes `_checkEntryPointOrSelf`).
     *         To revoke a key pass `validUntil = 0`.
     *
     * @param keeper     The keeper-bot EOA to authorize.
     * @param validUntil Unix timestamp after which the session key expires.
     *                   Must be strictly greater than `block.timestamp` unless
     *                   revoking (validUntil == 0).
     */
    function registerSessionKey(address keeper, uint48 validUntil) external {
        _onlyOwnerOrSelf();
        if (keeper == address(0)) revert SentinelVault__ZeroAddress();
        // NOTE: block.timestamp is intentionally used here — session keys are
        //       time-bounded by design. Validator manipulation risk is accepted.
        if (validUntil != 0 && validUntil <= uint48(block.timestamp)) {
            revert SentinelVault__InvalidExpiry();
        }

        sessionKeys[keeper] = validUntil;
        emit SessionKeyRegistered(keeper, validUntil);
    }

    // ─── Signature Validation (AbstractSigner override) ───────────────────────

    /**
     * @notice Validates a raw signature against either the owner or an active
     *         session key.
     * @dev    Called by the OZ `Account` base during `validateUserOp`.
     *         The `userOpHash` is already the EIP-191 / EIP-712 signable hash
     *         produced by `_signableUserOpHash` in the base contract.
     *
     *         Validation passes when:
     *           1. The recovered signer is the `owner`, OR
     *           2. The recovered signer is a registered session key whose
     *              `validUntil` timestamp has NOT expired.
     *
     * @param hash      The signable hash of the user operation.
     * @param signature The 65-byte ECDSA signature (r, s, v).
     * @return          True if valid; false otherwise.
     */
    function _rawSignatureValidation(
        bytes32 hash,
        bytes calldata signature
    ) internal view override returns (bool) {
        // Recover signer; ECDSA.tryRecover returns address(0) on failure.
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);

        // Return false on any recovery error (malformed sig, wrong length …).
        if (err != ECDSA.RecoverError.NoError) return false;

        // Path 1: owner signature — always valid.
        if (recovered == owner) return true;

        // Path 2: active session key — valid while not expired.
        uint48 expiry = sessionKeys[recovered];
        // NOTE: block.timestamp intentional — see registerSessionKey.
        if (expiry != 0 && block.timestamp <= expiry) return true;

        return false;
    }

    // ─── Aave V3 IFlashLoanSimpleReceiver Implementation ─────────────────────

    /**
     * @notice Required by IFlashLoanSimpleReceiver.
     * @dev    Returns the Aave V3 PoolAddressesProvider for this network.
     */
    function ADDRESSES_PROVIDER()
        external
        view
        override
        returns (IPoolAddressesProvider)
    {
        return _addressesProvider;
    }

    /**
     * @notice Required by IFlashLoanSimpleReceiver.
     * @dev    Resolves the active Pool address from the PoolAddressesProvider.
     *         Returns address(0) if the provider was not set (local dev).
     */
    function POOL() public view override returns (IPool) {
        if (address(_addressesProvider) == address(0)) return IPool(address(0));
        return IPool(_addressesProvider.getPool());
    }

    /**
     * @notice Flash loan callback — Phase 2 financial logic placeholder.
     * @dev    This function is called by the Aave Pool after transferring the
     *         borrowed `asset` to this contract.  The implementation MUST
     *         approve the Pool for `amount + premium` before returning `true`.
     *
     *         ⚠️  PHASE 2 STUB — all arbitrage / liquidation logic will be
     *              injected here in Phase 2.  Returning `true` unconditionally
     *              here would cause the Pool to attempt a repayment that will
     *              revert if funds are absent; in production this body must be
     *              replaced before deployment.
     *
     * @param asset     The address of the flash-borrowed ERC-20 token.
     * @param amount    The amount borrowed.
     * @param premium   The flash-loan fee owed on top of `amount`.
     * @param initiator The address that triggered the flash loan.
     * @param params    Arbitrary encoded parameters forwarded by the initiator.
     * @return          True if the operation succeeds (debt must be repaid).
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL()), "SentinelVault__UnauthorizedCaller");
        (initiator); // Silence unused variable warning

        // Decode wethAmountToSell from keeper params
        uint256 wethAmountToSell = abi.decode(params, (uint256));

        // Step A: Repay the vault's Aave debt using the flash-loaned USDC
        IERC20(asset).approve(address(POOL()), amount);
        POOL().repay(asset, amount, 2, address(this));

        // Step B: Withdraw the freed WETH collateral from Aave
        POOL().withdraw(weth, wethAmountToSell, address(this));

        // Step C: Enforce the guardrail
        _enforceSlippageGuardrail(wethAmountToSell, amount + premium);

        // Step D: Approve the Uniswap V3 Router to spend the withdrawn WETH
        IERC20(weth).approve(address(uniswapRouter), wethAmountToSell);

        // Step E: Use exactInputSingle to swap WETH for USDC
        ISwapRouter.ExactInputSingleParams memory swapParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: weth,
            tokenOut: asset,
            fee: 3000,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: wethAmountToSell,
            amountOutMinimum: amount + premium,
            sqrtPriceLimitX96: 0
        });
        uniswapRouter.exactInputSingle(swapParams);

        // Step F: Approve Aave to pull the flash loan repayment
        IERC20(asset).approve(address(POOL()), amount + premium);

        return true;
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    /**
     * @notice Enforces a strict slippage guardrail using Chainlink price feed.
     * @param wethAmountIn The amount of WETH to be sold.
     * @param botProposedUsdcOut The amount of USDC needed to repay the flash loan.
     */
    function _enforceSlippageGuardrail(uint256 wethAmountIn, uint256 botProposedUsdcOut) internal view {
        (, int256 price, , , ) = chainlinkWethUsd.latestRoundData();
        require(price > 0, "SentinelVault__InvalidOraclePrice");

        // WETH has 18 decimals, Chainlink ETH/USD has 8 decimals, USDC has 6 decimals
        // fairValueUsdc calculation correctly normalizes the scale (18 + 8) - 6 = 20
        uint256 fairValueUsdc = (wethAmountIn * uint256(price)) / 10**20;

        // Apply 1.5% Slippage Tolerance (9850 / 10000)
        uint256 minimumAcceptableUsdc = (fairValueUsdc * 9850) / 10000;

        require(botProposedUsdcOut >= minimumAcceptableUsdc, "SentinelVault__SlippageExceeded");
    }

    /**
     * @dev Reverts unless the caller is the owner or the account itself
     *      (i.e. a userOp routed through the EntryPoint).
     */
    function _onlyOwnerOrSelf() internal view {
        if (msg.sender != owner && msg.sender != address(this)) {
            revert SentinelVault__Unauthorized();
        }
    }
}
