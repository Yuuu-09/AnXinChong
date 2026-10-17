// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "../TestBase.sol";
import {AnXinChongUserRegistry as Registry} from "../../src/AnXinChongUserRegistry.sol";

contract RegistryWallet {
    function register(Registry registry, string calldata handle, string calldata nickname) external {
        registry.registerUser(handle, nickname);
    }

    function rename(Registry registry, string calldata nickname) external {
        registry.updateNickname(nickname);
    }
}

contract UserRegistryTest is TestBase {
    Registry registry;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        registry = new Registry();
    }

    function _register(address account, string memory handle, string memory nickname) private {
        vm.prank(account);
        registry.registerUser(handle, nickname);
    }

    function _text(string memory a, string memory b) private pure {
        eq(keccak256(bytes(a)), keccak256(bytes(b)));
    }

    function testWalletOwnsProfileAndHandleResolvesBack() public {
        _register(alice, "alice_123", unicode"小明");
        Registry.Profile memory p = registry.getProfile(alice);
        _text(p.handle, "alice_123");
        _text(p.nickname, unicode"小明");
        eq(registry.resolveHandle("alice_123"), alice);
        eq(registry.userCount(), 1);
    }

    function testHandleCannotBeChangedOrReleasedByRegisteringAgain() public {
        _register(alice, "alice", "Alice");
        vm.prank(alice);
        vm.expectRevert(Registry.AlreadyRegistered.selector);
        registry.registerUser("new_alice", "New");
        eq(registry.resolveHandle("alice"), alice);
        eq(registry.resolveHandle("new_alice"), address(0));
        eq(registry.userCount(), 1);
    }

    function testDuplicateHandleRejectedWithoutCreatingOtherProfile() public {
        _register(alice, "same_handle", "Alice");
        vm.prank(bob);
        vm.expectRevert(Registry.HandleTaken.selector);
        registry.registerUser("same_handle", "Bob");
        _text(registry.getProfile(bob).handle, "");
        eq(registry.userCount(), 1);
    }

    function testNicknameChangesOnlyOwnProfileAndDoesNotChangeHandle() public {
        _register(alice, "alice", "Same name");
        _register(bob, "bobby", "Same name");
        vm.prank(bob);
        registry.updateNickname(unicode"新的昵称");
        _text(registry.getProfile(alice).nickname, "Same name");
        _text(registry.getProfile(bob).nickname, unicode"新的昵称");
        _text(registry.getProfile(bob).handle, "bobby");
        eq(registry.resolveHandle("bobby"), bob);
        eq(registry.userCount(), 2);
    }

    function testUnregisteredWalletCannotRenameAndUnknownReadIsEmpty() public {
        _text(registry.getProfile(bob).handle, "");
        _text(registry.getProfile(bob).nickname, "");
        eq(registry.resolveHandle("unknown"), address(0));
        vm.prank(bob);
        vm.expectRevert(Registry.NotRegistered.selector);
        registry.updateNickname("Name");
    }

    function testHandleFormatAndLengthBoundaries() public {
        string[9] memory bad =
            ["", "ab", "abcdefghijklmnopqrstuvwxy", "Alice", "@alice", "a-b", "a.b", "a b", unicode"用户一"];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(Registry.InvalidHandle.selector);
            registry.registerUser(bad[i], "Name");
        }
        _register(alice, "a_0", "Alice");
        _register(bob, "abcdefghijklmnopqrstuvwx", "Bob");
        eq(registry.userCount(), 2);
    }

    function testNicknameByteLimitControlsAndWhitespace() public {
        string[5] memory bad = ["", "   ", "line\nbreak", "tab\tname", string(new bytes(97))];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(Registry.InvalidNickname.selector);
            registry.registerUser("alice", bad[i]);
            eq(registry.userCount(), 0);
        }
        bytes memory maxName = new bytes(96);
        for (uint256 i; i < 96; ++i) {
            maxName[i] = 0x61;
        }
        _register(alice, "alice", string(maxName));
        vm.prank(alice);
        vm.expectRevert(Registry.InvalidNickname.selector);
        registry.updateNickname("");
        _text(registry.getProfile(alice).nickname, string(maxName));
        _text(registry.getProfile(alice).handle, "alice");
    }

    function testChineseNicknameUsesBytesNotCharacters() public {
        string memory name;
        for (uint256 i; i < 32; ++i) {
            name = string.concat(name, unicode"名");
        }
        _register(alice, "alice", name);
        vm.prank(alice);
        vm.expectRevert(Registry.InvalidNickname.selector);
        registry.updateNickname(string.concat(name, unicode"名"));
    }

    function testSmartContractWalletOwnsItsOwnProfile() public {
        RegistryWallet wallet = new RegistryWallet();
        wallet.register(registry, "smart_wallet", "Wallet");
        wallet.rename(registry, "New name");
        eq(registry.resolveHandle("smart_wallet"), address(wallet));
        _text(registry.getProfile(address(wallet)).nickname, "New name");
    }

    function testNoHandleMutationOrTransferEntryPoint() public {
        _register(alice, "alice", "Alice");
        vm.startPrank(alice);
        (bool renamed,) = address(registry).call(abi.encodeWithSignature("updateHandle(string)", "changed"));
        (bool transferred,) = address(registry).call(abi.encodeWithSignature("transferHandle(address)", bob));
        vm.stopPrank();
        require(!renamed && !transferred, "permanent handle");
        eq(registry.resolveHandle("alice"), alice);
    }

    function testFuzzRenamePreservesPermanentHandle(uint256 seed) public {
        _register(alice, "alice", "Name");
        bytes memory nickname = new bytes(1 + seed % 96);
        for (uint256 i; i < nickname.length; ++i) {
            nickname[i] = bytes1(uint8(97 + (seed % 26)));
        }
        vm.prank(alice);
        registry.updateNickname(string(nickname));
        _text(registry.getProfile(alice).handle, "alice");
        eq(registry.resolveHandle("alice"), alice);
        eq(registry.userCount(), 1);
    }
}
