// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AnXinChongUserRegistry} from "../../src/AnXinChongUserRegistry.sol";
import {TestBase} from "../TestBase.sol";
import {AnXinChongFactory as Factory} from "../../src/AnXinChongFactory.sol";
import {AnXinChongVault as Vault} from "../../src/AnXinChongVault.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract FactoryTest is TestBase {
    MockUSDC token;
    Factory factory;
    AnXinChongUserRegistry registry;
    address a;
    address b;
    address consumer;

    function setUp() public {
        vm.warp(1000);
        a = vm.addr(101);
        b = vm.addr(102);
        consumer = vm.addr(103);
        token = new MockUSDC();
        registry = new AnXinChongUserRegistry();
        _registerUser(registry, a);
        _registerUser(registry, b);
        _registerUser(registry, consumer);
        _registerUser(registry, address(this));
        factory = new Factory(address(token), address(registry));
        _registerUser(registry, address(factory));
        token.mint(consumer, 1000e6);
    }

    function _create(address owner) private returns (Vault vault) {
        vm.prank(owner);
        (, address target) = factory.registerMerchant(Vault.Profile("Shop", "Independent vault"), owner);
        return Vault(target);
    }

    function _plan(Vault vault, address owner) private returns (uint256) {
        Vault.PlanParams memory p;
        p.merchantId = vault.merchantId();
        p.name = "Stored";
        p.minDeposit = 1;
        p.discountBps = 10000;
        vm.prank(owner);
        return vault.createPlanVersion(p);
    }

    function _buy(Vault vault, uint256 plan, uint256 amount) private returns (uint256) {
        Vault.PurchaseQuote memory q = vault.quotePurchase(plan, amount, consumer);
        vm.startPrank(consumer);
        token.approve(address(vault), amount);
        uint256 id = vault.buy(plan, amount, q.termsHash);
        vm.stopPrank();
        return id;
    }

    function testFactoryCreatesCompleteImmutableVaultsAndDirectory() public {
        Vault va = _create(a);
        Vault vb = _create(b);
        require(address(va) != address(vb), "separate addresses");
        eq(va.factory(), address(factory));
        eq(vb.factory(), address(factory));
        eq(address(va.asset()), address(token));
        eq(va.merchantId(), 1);
        eq(vb.merchantId(), 2);
        eq(factory.merchantCount(), 2);
        eq(factory.merchantOf(a), 1);
        eq(factory.vaultOf(2), address(vb));
        eq(factory.merchantIdOfVault(address(va)), 1);
        eq(factory.vaultDeploymentBlock(1), block.number);
        eq(factory.getMerchant(2).owner, b);
        eq(factory.getMerchant(2).vault, address(vb));
        eq(token.balanceOf(address(factory)), 0);
    }

    function testDuplicateRegistrationCannotReplaceVault() public {
        Vault original = _create(a);
        vm.prank(a);
        vm.expectRevert(Factory.AlreadyRegistered.selector);
        factory.registerMerchant(Vault.Profile("Duplicate", ""), a);
        eq(factory.merchantCount(), 1);
        eq(factory.vaultOf(1), address(original));
    }

    function testUnregisteredWalletMustRegisterUserBeforeCreatingMerchant() public {
        address outsider = address(0xBEEF);
        vm.prank(outsider);
        vm.expectRevert(Factory.UserRegistrationRequired.selector);
        factory.registerMerchant(Vault.Profile("Shop", ""), outsider);
        eq(factory.merchantCount(), 0);
        _registerUser(registry, outsider);
        Vault vault = _create(outsider);
        eq(address(vault.userRegistry()), address(registry));
        eq(vault.getMerchant(1).owner, outsider);
    }

    function testInvalidRegistrationRollsBackDirectory() public {
        vm.prank(a);
        vm.expectRevert(Vault.InvalidParameters.selector);
        factory.registerMerchant(Vault.Profile("", ""), a);
        eq(factory.merchantCount(), 0);
        eq(factory.merchantOf(a), 0);
        eq(factory.vaultOf(1), address(0));
        Vault vault = _create(a);
        eq(vault.merchantId(), 1);
    }

    function testInvalidPayoutAndUnsupportedAssetRejected() public {
        vm.expectRevert();
        new Factory(address(0), address(registry));
        vm.prank(a);
        vm.expectRevert(Vault.InvalidAddress.selector);
        factory.registerMerchant(Vault.Profile("Shop", ""), address(0));
        vm.prank(a);
        vm.expectRevert(Factory.InvalidParameters.selector);
        factory.registerMerchant(Vault.Profile("Shop", ""), address(factory));
        eq(factory.merchantCount(), 0);
    }

    function testDirectoryTracksUpdatedProfileWithoutReplacingVault() public {
        Vault vault = _create(a);
        vm.prank(a);
        vault.updateMerchantProfile(1, Vault.Profile("Updated", "New description"), b);
        Factory.MerchantInfo memory info = factory.getMerchant(1);
        eq(keccak256(bytes(info.name)), keccak256("Updated"));
        eq(info.defaultPayout, b);
        eq(info.owner, a);
        eq(info.vault, address(vault));
    }

    function testFactoryAndOtherMerchantHaveNoVaultAuthority() public {
        Vault vault = _create(a);
        uint256 plan = _plan(vault, a);
        vm.prank(address(factory));
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.setPlanActive(plan, false);
        vm.prank(b);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.setPlanActive(plan, false);
        vm.prank(a);
        vm.expectRevert(Vault.NotFound.selector);
        vault.updateMerchantProfile(2, Vault.Profile("Foreign", ""), a);
        (bool ok,) = address(vault)
            .call(abi.encodeWithSignature("registerMerchant((string,string),address)", Vault.Profile("Extra", ""), b));
        require(!ok, "vault cannot register a second merchant");
    }

    function testPaginationAndUnknownVault() public {
        _create(a);
        _create(b);
        (uint256[] memory ids, uint256 next) = factory.listMerchants(0, 1);
        eq(ids[0], 1);
        eq(next, 1);
        (ids, next) = factory.listMerchants(next, 1);
        eq(ids[0], 2);
        eq(next, 2);
        (ids,) = factory.listMerchants(next, 100);
        eq(ids.length, 0);
        vm.expectRevert(Factory.InvalidParameters.selector);
        factory.listMerchants(0, 101);
        vm.expectRevert(Factory.InvalidParameters.selector);
        factory.listMerchants(3, 1);
        vm.expectRevert(Factory.NotFound.selector);
        factory.getMerchant(999);
        eq(factory.merchantIdOfVault(address(token)), 0);
    }

    function testAllowanceToOneVaultCannotFundAnother() public {
        Vault va = _create(a);
        Vault vb = _create(b);
        uint256 pa = _plan(va, a);
        uint256 pb = _plan(vb, b);
        vm.prank(consumer);
        token.approve(address(va), 500e6);
        Vault.PurchaseQuote memory q = vb.quotePurchase(pb, 100e6, consumer);
        vm.prank(consumer);
        vm.expectRevert();
        vb.buy(pb, 100e6, q.termsHash);
        eq(vb.membershipCount(), 0);
        eq(token.balanceOf(address(vb)), 0);
        _buy(va, pa, 500e6);
        eq(token.balanceOf(address(va)), 500e6);
        eq(token.balanceOf(address(factory)), 0);
    }

    function testTransferFailureInOneVaultDoesNotBlockOtherVault() public {
        Vault va = _create(a);
        Vault vb = _create(b);
        _buy(va, _plan(va, a), 500e6);
        _buy(vb, _plan(vb, b), 300e6);
        token.setBlocked(address(va), true);
        vm.prank(consumer);
        vm.expectRevert();
        va.exit(1, 500e6, false);
        vm.prank(consumer);
        vb.exit(1, 300e6, false);
        eq(va.getMembership(1).remainingPrincipal, 500e6);
        eq(vb.getMembership(1).refundedAmount, 300e6);
        eq(token.balanceOf(address(va)), 500e6);
        eq(token.balanceOf(address(vb)), 0);
    }

    function testMatchingLocalCardIdsCannotReplaySignaturesAcrossVaults() public {
        Vault va = _create(a);
        // Same owner and global/local IDs in another factory isolate the EIP-712 domain test.
        Factory other = new Factory(address(token), address(registry));
        vm.prank(a);
        (, address target) = other.registerMerchant(Vault.Profile("Shop", "Independent vault"), a);
        Vault vb = Vault(target);
        _buy(va, _plan(va, a), 300e6);
        _buy(vb, _plan(vb, a), 300e6);
        Vault.Membership memory m = vb.getMembership(1);
        Vault.Bill memory bill;
        bill.membershipId = 1;
        bill.termsHash = m.termsHash;
        bill.merchantSigner = a;
        bill.consumer = consumer;
        bill.originalValue = 100e6;
        bill.debitAmount = 100e6;
        bill.discountBps = 10000;
        bill.issuedAt = block.timestamp;
        bill.deadline = block.timestamp + 900;
        bytes32 digest = va.billDigest(bill);
        require(digest != vb.billDigest(bill), "domains must differ");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(101, digest);
        bytes memory ms = abi.encodePacked(r, s, v);
        (v, r, s) = vm.sign(103, digest);
        vm.expectRevert(Vault.InvalidSignature.selector);
        vb.settle(bill, ms, abi.encodePacked(r, s, v));
        eq(token.balanceOf(address(va)), 300e6);
        eq(token.balanceOf(address(vb)), 300e6);
        eq(vb.getMembership(1).nextNonce, 0);
    }
}
