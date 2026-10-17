// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {AnXinChongFactory} from "../src/AnXinChongFactory.sol";
import {AnXinChongUserRegistry} from "../src/AnXinChongUserRegistry.sol";

interface DeployVm {
    function envAddress(string calldata name) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract Deploy {
    DeployVm constant vm = DeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (AnXinChongFactory factory, AnXinChongUserRegistry userRegistry) {
        require(block.chainid == 10143, "Monad Testnet only");
        address token = vm.envAddress("USDC_ADDRESS");
        vm.startBroadcast();
        userRegistry = new AnXinChongUserRegistry();
        factory = new AnXinChongFactory(token, address(userRegistry));
        vm.stopBroadcast();
    }
}
