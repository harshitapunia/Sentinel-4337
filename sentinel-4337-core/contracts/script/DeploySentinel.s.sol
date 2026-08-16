// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {SentinelVaultFactory} from "../src/SentinelVaultFactory.sol";

contract DeploySentinel is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        SentinelVaultFactory factory = new SentinelVaultFactory();

        vm.stopBroadcast();
    }
}
