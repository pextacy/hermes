// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {HermesHTLC} from "../src/HermesHTLC.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Deploy: the owner supplies the key at runtime, e.g.
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --interactives 1
/// (no .env; the key is typed into the prompt). Set DEPLOY_MOCK=1 for a local anvil token.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        HermesHTLC htlc = new HermesHTLC();
        console2.log("HermesHTLC", address(htlc));
        if (vm.envOr("DEPLOY_MOCK", uint256(0)) == 1) {
            MockUSDC usdc = new MockUSDC();
            console2.log("MockUSDC", address(usdc));
        }
        vm.stopBroadcast();
    }
}
