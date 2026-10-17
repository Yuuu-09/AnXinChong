// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {AnXinChongUserRegistry} from "../src/AnXinChongUserRegistry.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 chainId_) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _registerUser(AnXinChongUserRegistry registry, address account) internal {
        if (registry.isRegistered(account)) return;
        vm.prank(account);
        registry.registerUser(Strings.toHexString(uint80(uint160(account)), 10), "Fixture user");
    }

    function eq(uint256 a, uint256 b) internal pure {
        require(a == b, "uint assertion");
    }

    function eq(address a, address b) internal pure {
        require(a == b, "address assertion");
    }

    function eq(bytes32 a, bytes32 b) internal pure {
        require(a == b, "bytes assertion");
    }
}
