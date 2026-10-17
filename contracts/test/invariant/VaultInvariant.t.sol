// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AnXinChongUserRegistry} from "../../src/AnXinChongUserRegistry.sol";
import {TestBase} from "../TestBase.sol";
import {AnXinChongVault as Vault} from "../../src/AnXinChongVault.sol";
import {AnXinChongFactory as Factory} from "../../src/AnXinChongFactory.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {SettlementMath} from "../../src/libraries/SettlementMath.sol";

contract VaultHandler is TestBase {
    Vault public vault;
    MockUSDC public token;
    uint256 internal immutable MPK;
    uint256 constant CPK = 0xB0B;
    address public merchant;
    address public consumer;
    uint256 public stored;
    uint256 public visits;
    uint256 public purchases;
    uint256 public consumptions;
    uint256 public exits;
    uint256 public cancellations;

    constructor(MockUSDC token_, Factory factory, uint256 merchantKey) {
        MPK = merchantKey;
        merchant = vm.addr(MPK);
        consumer = vm.addr(CPK);
        token = token_;
        _registerUser(factory.userRegistry(), merchant);
        _registerUser(factory.userRegistry(), consumer);
        _registerUser(factory.userRegistry(), address(this));
        vm.prank(merchant);
        (uint256 mid, address target) = factory.registerMerchant(Vault.Profile("Invariant", ""), merchant);
        vault = Vault(target);
        Vault.PlanParams memory p;
        p.merchantId = mid;
        p.name = "Stored";
        p.minDeposit = 1;
        p.discountBps = 9000;
        p.channelRecipient = address(0x1111);
        p.channelBps = 200;
        p.referralBps = 300;
        vm.prank(merchant);
        stored = vault.createPlanVersion(p);
        p.name = "Visits";
        p.mode = Vault.Mode.VisitCount;
        p.minDeposit = 0;
        p.discountBps = 0;
        p.minUnits = 1;
        p.listUnitPrice = 88e6;
        p.saleUnitPrice = 58e6;
        vm.prank(merchant);
        visits = vault.createPlanVersion(p);
        vm.prank(merchant);
        vault.setReferral(mid, consumer, address(0x2222));
        buy(0, false);
        buy(0, true);
    }

    function buy(uint256 seed, bool count) public {
        uint256 plan = count ? visits : stored;
        uint256 quantity = count ? 10 + seed % 10 : (500 + seed % 500) * 1e6;
        Vault.PurchaseQuote memory q = vault.quotePurchase(plan, quantity, consumer);
        token.mint(consumer, q.principal);
        vm.startPrank(consumer);
        token.approve(address(vault), q.principal);
        vault.buy(plan, quantity, q.termsHash);
        vm.stopPrank();
        purchases++;
    }

    function consume(uint256 seed) external {
        uint256 id = 1 + seed % vault.membershipCount();
        Vault.Membership memory m = vault.getMembership(id);
        if (m.lifecycle == Vault.Lifecycle.Exited || m.remainingPrincipal == 0) return;
        Vault.Bill memory b;
        b.membershipId = id;
        b.termsHash = m.termsHash;
        b.merchantSigner = m.merchantSigner;
        b.consumer = m.consumer;
        b.mode = uint8(m.mode);
        b.nonce = m.nextNonce;
        b.issuedAt = block.timestamp;
        b.deadline = block.timestamp + 900;
        if (m.mode == Vault.Mode.StoredValue) {
            b.originalValue = 1 + seed % m.remainingPrincipal;
            b.discountBps = m.discountBps;
            b.debitAmount = SettlementMath.discounted(b.originalValue, m.discountBps);
        } else {
            b.units = 1 + seed % (m.purchasedUnits - m.usedUnits);
            b.originalValue = b.units * m.listUnitPrice;
            b.debitAmount = b.units * m.saleUnitPrice;
        }
        bytes32 digest = vault.billDigest(b);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(MPK, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(CPK, digest);
        vault.settle(b, abi.encodePacked(r1, s1, v1), abi.encodePacked(r2, s2, v2));
        consumptions++;
    }

    function leave(uint256 seed) external {
        uint256 id = 1 + seed % vault.membershipCount();
        if (vault.getMembership(id).lifecycle == Vault.Lifecycle.Exited) return;
        vm.prank(consumer);
        vault.exit(id, 0, true);
        exits++;
    }

    function cancel(uint256 seed) external {
        uint256 id = 1 + seed % vault.membershipCount();
        Vault.Membership memory m = vault.getMembership(id);
        if (m.lifecycle == Vault.Lifecycle.Exited) return;
        vm.prank(consumer);
        vault.invalidateNonce(id, m.nextNonce);
        cancellations++;
    }

    function drain() external {
        for (uint256 id = 1; id <= vault.membershipCount(); ++id) {
            if (vault.getMembership(id).lifecycle == Vault.Lifecycle.Active) {
                vm.prank(consumer);
                vault.exit(id, 0, true);
            }
        }
    }
}

contract VaultInvariantTest is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }
    VaultHandler handler;
    VaultHandler second;
    Factory factory;
    MockUSDC token;

    function setUp() public {
        vm.warp(1000);
        token = new MockUSDC();
        factory = new Factory(address(token), address(new AnXinChongUserRegistry()));
        handler = new VaultHandler(token, factory, 0xA11CE);
        second = new VaultHandler(token, factory, 0xCAFE);
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](2);
        targets[0] = address(handler);
        targets[1] = address(second);
    }

    function targetSelectors() external view returns (FuzzSelector[] memory targets) {
        targets = new FuzzSelector[](2);
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = VaultHandler.buy.selector;
        selectors[1] = VaultHandler.consume.selector;
        selectors[2] = VaultHandler.leave.selector;
        selectors[3] = VaultHandler.cancel.selector;
        targets[0] = FuzzSelector(address(handler), selectors);
        targets[1] = FuzzSelector(address(second), selectors);
    }

    function invariant_FundsAndSnapshotsAreConserved() public view {
        _checkVault(handler);
        _checkVault(second);
        eq(token.balanceOf(address(factory)), 0);
        require(address(handler.vault()) != address(second.vault()), "vaults must differ");
    }

    function _checkVault(VaultHandler current) private view {
        Vault v = current.vault();
        uint256 sum;
        for (uint256 id = 1; id <= v.membershipCount(); ++id) {
            Vault.Membership memory m = v.getMembership(id);
            sum += m.remainingPrincipal;
            eq(
                m.initialPrincipal,
                m.remainingPrincipal + m.refundedAmount + m.merchantPaid + m.channelPaid + m.referralPaid
            );
            eq(m.totalReleased, m.merchantPaid + m.channelPaid + m.referralPaid);
            eq(m.channelBps, 200);
            eq(m.referralBps, 300);
            eq(m.consumer, current.consumer());
            require(m.usedUnits + m.forfeitedUnits <= m.purchasedUnits, "units exceed purchase");
            if (m.lifecycle == Vault.Lifecycle.Exited) eq(m.remainingPrincipal, 0);
        }
        eq(v.totalEscrowed(), sum);
        eq(token.balanceOf(address(v)), sum);
        eq(v.getMerchantStats(v.merchantId()).escrowed, sum);
    }

    function afterInvariant() public {
        handler.drain();
        second.drain();
        invariant_FundsAndSnapshotsAreConserved();
        eq(handler.vault().totalEscrowed(), 0);
        eq(second.vault().totalEscrowed(), 0);
    }
}
