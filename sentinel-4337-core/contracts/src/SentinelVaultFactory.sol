// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {SentinelVault} from "./SentinelVault.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {IPoolAddressesProvider} from "aave-v3-core/contracts/interfaces/IPoolAddressesProvider.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

contract SentinelVaultFactory {
    // ─── Hardcoded Sepolia Configuration ──────────────────────────────
    // To keep the factory deployment simple via `forge create` without args:
    address constant ENTRY_POINT = address(0); // Uses default EntryPoint v0.9
    address constant AAVE_ADDRESSES_PROVIDER = 0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address constant USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
    address constant CHAINLINK_ETH_USD = 0x694AA1769357215DE4FAC081bf1f309aDC325306;
    address constant UNISWAP_ROUTER = 0x3bFa4769F01138D8F564A2C5C8b49A7e83B749f7;

    /**
     * @notice Deploys a new SentinelVault using CREATE2.
     * @param owner The owner of the vault.
     * @param salt Deterministic salt for CREATE2 address derivation.
     */
    function createAccount(address owner, uint256 salt) public returns (address ret) {
        address addr = getAddress(owner, salt);
        uint256 codeSize = addr.code.length;
        if (codeSize > 0) {
            return addr; // Already deployed
        }

        bytes memory bytecode = abi.encodePacked(
            type(SentinelVault).creationCode,
            abi.encode(
                IEntryPoint(ENTRY_POINT),
                owner,
                IPoolAddressesProvider(AAVE_ADDRESSES_PROVIDER),
                WETH,
                USDC,
                AggregatorV3Interface(CHAINLINK_ETH_USD),
                ISwapRouter(UNISWAP_ROUTER)
            )
        );

        ret = Create2.deploy(0, bytes32(salt), bytecode);
    }

    /**
     * @notice Calculates the deterministic CREATE2 address for a SentinelVault.
     * @param owner The owner of the vault.
     * @param salt Deterministic salt.
     */
    function getAddress(address owner, uint256 salt) public view returns (address) {
        bytes memory bytecode = abi.encodePacked(
            type(SentinelVault).creationCode,
            abi.encode(
                IEntryPoint(ENTRY_POINT),
                owner,
                IPoolAddressesProvider(AAVE_ADDRESSES_PROVIDER),
                WETH,
                USDC,
                AggregatorV3Interface(CHAINLINK_ETH_USD),
                ISwapRouter(UNISWAP_ROUTER)
            )
        );

        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(salt),
                keccak256(bytecode)
            )
        );
        return address(uint160(uint256(hash)));
    }
}
