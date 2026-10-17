// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AnXinChongUserRegistry} from "../../src/AnXinChongUserRegistry.sol";
import {TestBase} from "../TestBase.sol";
import {AnXinChongVault as Vault} from "../../src/AnXinChongVault.sol";
import {AnXinChongFactory as Factory} from "../../src/AnXinChongFactory.sol";
import {SettlementMath} from "../../src/libraries/SettlementMath.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract CallbackToken is MockUSDC {
    address public target;
    bytes public payload;
    bytes4 public observedError;
    bool private entered;

    function setCallback(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (target != address(0) && msg.sender == target && !entered) {
            entered = true;
            (bool success, bytes memory reason) = target.call(payload);
            require(!success, "reentry unexpectedly succeeded");
            observedError = bytes4(reason);
            entered = false;
        }
    }
}

contract MockSmartWallet is IERC1271 {
    address public immutable signer;
    bool public enabled = true;

    constructor(address signer_) {
        signer = signer_;
    }

    function disable() external {
        enabled = false;
    }

    function isValidSignature(bytes32 digest, bytes memory signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError failure,) = ECDSA.tryRecover(digest, signature);
        return enabled && failure == ECDSA.RecoverError.NoError && recovered == signer
            ? IERC1271.isValidSignature.selector
            : bytes4(0);
    }
}

contract VaultTest is TestBase {
    uint256 constant U = 1e6;
    uint256 constant MPK = 0xA11CE;
    uint256 constant CPK = 0xB0B;
    uint256 constant C2PK = 0xCAFE;
    address m;
    address c;
    address c2;
    address h = address(0x1111);
    address inviter = address(0x2222);
    MockUSDC token;
    Vault vault;
    Factory factory;
    AnXinChongUserRegistry registry;
    uint256 merchant;
    uint256 stored;
    uint256 visits;

    function setUp() public {
        vm.warp(1000);
        vm.chainId(10143);
        m = vm.addr(MPK);
        c = vm.addr(CPK);
        c2 = vm.addr(C2PK);
        token = new MockUSDC();
        registry = new AnXinChongUserRegistry();
        _registerUser(registry, m);
        _registerUser(registry, c);
        _registerUser(registry, c2);
        _registerUser(registry, address(this));
        factory = new Factory(address(token), address(registry));
        vm.prank(m);
        address target;
        (merchant, target) = factory.registerMerchant(Vault.Profile("Test Shop", "Local fixture"), m);
        vault = Vault(target);
        stored = _plan(Vault.Mode.StoredValue, 9000, 200, 300, h);
        visits = _plan(Vault.Mode.VisitCount, 0, 200, 300, h);
        vm.prank(m);
        vault.setReferral(merchant, c, inviter);
        token.mint(c, 10_000 * U);
        token.mint(c2, 10_000 * U);
        token.mint(m, 10_000 * U);
    }

    function _plan(Vault.Mode mode, uint256 discount, uint256 cb, uint256 rb, address channel)
        internal
        returns (uint256)
    {
        Vault.PlanParams memory p;
        p.merchantId = merchant;
        p.mode = mode;
        p.name = "Fixture";
        p.channelRecipient = channel;
        p.channelBps = cb;
        p.referralBps = rb;
        if (mode == Vault.Mode.StoredValue) {
            p.minDeposit = U;
            p.discountBps = discount;
        } else {
            p.minUnits = 10;
            p.listUnitPrice = 88 * U;
            p.saleUnitPrice = 58 * U;
        }
        vm.prank(m);
        return vault.createPlanVersion(p);
    }

    function _buy(uint256 plan, uint256 amount, address buyer) internal returns (uint256 id) {
        Vault.PurchaseQuote memory q = vault.quotePurchase(plan, amount, buyer);
        vm.startPrank(buyer);
        token.approve(address(vault), q.principal);
        id = vault.buy(plan, amount, q.termsHash);
        vm.stopPrank();
    }

    function _bill(uint256 id, uint256 original, uint256 units) internal view returns (Vault.Bill memory b) {
        Vault.Membership memory a = vault.getMembership(id);
        b.membershipId = id;
        b.termsHash = a.termsHash;
        b.merchantSigner = a.merchantSigner;
        b.consumer = a.consumer;
        b.mode = uint8(a.mode);
        b.nonce = a.nextNonce;
        b.issuedAt = block.timestamp;
        b.deadline = block.timestamp + 900;
        b.orderId = keccak256(abi.encode(id, a.nextNonce));
        b.serviceHash = keccak256("service");
        if (a.mode == Vault.Mode.StoredValue) {
            b.originalValue = original;
            b.discountBps = a.discountBps;
            b.debitAmount = SettlementMath.discounted(original, a.discountBps);
        } else {
            b.units = units;
            b.originalValue = units * a.listUnitPrice;
            b.debitAmount = units * a.saleUnitPrice;
        }
    }

    function _sig(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sign(Vault.Bill memory b) internal returns (bytes memory ms, bytes memory cs) {
        bytes32 digest = vault.billDigest(b);
        ms = _sig(MPK, digest);
        cs = _sig(b.consumer == m ? MPK : b.consumer == c2 ? C2PK : CPK, digest);
    }

    function _consume(uint256 id, uint256 original, uint256 units) internal {
        Vault.Bill memory b = _bill(id, original, units);
        (bytes memory ms, bytes memory cs) = _sign(b);
        vault.settle(b, ms, cs);
    }

    function _exit(uint256 id, uint256 minimum, bool zero) internal {
        vm.prank(vault.getMembership(id).consumer);
        vault.exit(id, minimum, zero);
    }

    function _conserved(uint256 id) internal view {
        Vault.Membership memory a = vault.getMembership(id);
        eq(
            a.initialPrincipal,
            a.remainingPrincipal + a.refundedAmount + a.merchantPaid + a.channelPaid + a.referralPaid
        );
        require(token.balanceOf(address(vault)) >= vault.totalEscrowed(), "insolvent");
    }

    function testAC01_DualRole() public {
        uint256 id = _buy(stored, 500 * U, m);
        _consume(id, 100 * U, 0);
        _exit(id, 400 * U, false);
        _conserved(id);
    }

    function testAC02_PurchaseEscrow() public {
        uint256 beforeM = token.balanceOf(m);
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Membership memory a = vault.getMembership(id);
        eq(a.remainingPrincipal, 500 * U);
        eq(a.discountBps, 9000);
        eq(token.balanceOf(address(vault)), 500 * U);
        eq(token.balanceOf(m), beforeM);
        eq(token.balanceOf(h), 0);
        eq(token.balanceOf(inviter), 0);
        _conserved(id);
    }

    function testAC03_StoredConsumption() public {
        uint256 id = _buy(stored, 500 * U, c);
        _consume(id, 200 * U, 0);
        Vault.Membership memory a = vault.getMembership(id);
        eq(a.remainingPrincipal, 320 * U);
        eq(a.totalOriginalValue, 200 * U);
        eq(a.totalActualSpend, 180 * U);
        _conserved(id);
    }

    function testAC04_StoredRefund() public {
        uint256 id = _buy(stored, 500 * U, c);
        _consume(id, 200 * U, 0);
        Vault.ExitQuote memory q = vault.previewExit(id);
        eq(q.actualTopUp, 20 * U);
        eq(q.refund, 300 * U);
        _exit(id, q.refund, false);
        eq(token.balanceOf(c), 9800 * U);
        _conserved(id);
    }

    function testAC05_InsufficientStoredBalance() public {
        uint256 id = _buy(stored, 500 * U, c);
        _consume(id, 466_666_666, 0);
        eq(vault.getMembership(id).remainingPrincipal, 80 * U);
        Vault.Bill memory b = _bill(id, 100 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        vm.expectRevert(Vault.InsufficientPrincipal.selector);
        vault.settle(b, ms, cs);
        eq(vault.getMembership(id).remainingPrincipal, 80 * U);
        eq(vault.getMembership(id).nextNonce, 1);
    }

    function testAC06_StoredZeroRefund() public {
        uint256 id = _buy(stored, 500 * U, c);
        _consume(id, 500 * U, 0);
        vm.prank(c);
        vm.expectRevert(Vault.ZeroRefundNotAuthorized.selector);
        vault.exit(id, 0, false);
        _exit(id, 0, true);
        eq(vault.getMembership(id).exitTopUp, 50 * U);
        _conserved(id);
    }

    function testAC07_CountRefund() public {
        uint256 id = _buy(visits, 10, c);
        _consume(id, 0, 3);
        Vault.ExitQuote memory q = vault.previewExit(id);
        eq(q.balance, 406 * U);
        eq(q.actualTopUp, 90 * U);
        eq(q.refund, 316 * U);
        _exit(id, 316 * U, false);
        eq(vault.getMembership(id).forfeitedUnits, 7);
        eq(vault.getMembership(id).usedUnits, 3);
        _conserved(id);
    }

    function testAC08_CountZeroRefund() public {
        uint256 id = _buy(visits, 10, c);
        _consume(id, 0, 7);
        Vault.ExitQuote memory q = vault.previewExit(id);
        eq(q.compensation, 210 * U);
        eq(q.actualTopUp, 174 * U);
        eq(q.refund, 0);
        token.setRejectZeroTransfers(true);
        _exit(id, 0, true);
        eq(vault.getMembership(id).forfeitedUnits, 3);
        _conserved(id);
    }

    function testAC09_UnusedFullRefund() public {
        uint256 a = _buy(stored, 500 * U, c);
        uint256 b = _buy(visits, 10, c);
        _exit(a, 500 * U, false);
        _exit(b, 580 * U, false);
        eq(token.balanceOf(c), 10_000 * U);
        eq(token.balanceOf(h), 0);
        _conserved(a);
        _conserved(b);
    }

    function testAC10_MissingSignatures() public {
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Bill memory b = _bill(id, 100 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        vm.expectRevert(Vault.InvalidSignature.selector);
        vault.settle(b, "", cs);
        vm.expectRevert(Vault.InvalidSignature.selector);
        vault.settle(b, ms, "");
        eq(vault.getMembership(id).nextNonce, 0);
        _conserved(id);
    }

    function testAC11_ReplayAndExpiry() public {
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Bill memory b = _bill(id, 100 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        vault.settle(b, ms, cs);
        vm.expectRevert(Vault.InvalidNonce.selector);
        vault.settle(b, ms, cs);
        b = _bill(id, 100 * U, 0);
        (ms, cs) = _sign(b);
        vm.warp(block.timestamp + 901);
        vm.expectRevert(Vault.InvalidTime.selector);
        vault.settle(b, ms, cs);
        _conserved(id);
    }

    function testAC12_InsufficientUnits() public {
        uint256 id = _buy(visits, 10, c);
        _consume(id, 0, 8);
        Vault.Bill memory b = _bill(id, 0, 3);
        (bytes memory ms, bytes memory cs) = _sign(b);
        vm.expectRevert(Vault.InsufficientUnits.selector);
        vault.settle(b, ms, cs);
        eq(vault.getMembership(id).usedUnits, 8);
    }

    function testAC13_Commissions() public {
        uint256 plan = _plan(Vault.Mode.StoredValue, 10_000, 200, 300, h);
        uint256 id = _buy(plan, 500 * U, c);
        _consume(id, 100 * U, 0);
        eq(token.balanceOf(h), 2 * U);
        eq(token.balanceOf(inviter), 3 * U);
        eq(vault.getMembership(id).merchantPaid, 95 * U);
        _conserved(id);
    }

    function testAC14_NoRecipients() public {
        uint256 plan = _plan(Vault.Mode.StoredValue, 10_000, 200, 300, address(0));
        uint256 id = _buy(plan, 100 * U, c2);
        _consume(id, 100 * U, 0);
        eq(vault.getMembership(id).merchantPaid, 100 * U);
        eq(vault.getMembership(id).referralBps, 0);
        _conserved(id);
    }

    function testAC15_PlanChangesDoNotAffectCards() public {
        uint256 id = _buy(stored, 500 * U, c);
        vm.prank(m);
        vault.updateMerchantProfile(merchant, Vault.Profile("New", ""), c2);
        vm.prank(m);
        vault.setPlanActive(stored, false);
        vm.expectRevert(Vault.PlanInactive.selector);
        vault.quotePurchase(stored, 500 * U, c);
        _consume(id, 200 * U, 0);
        _exit(id, 300 * U, false);
        eq(vault.getMembership(id).merchantPayout, m);
        _conserved(id);
    }

    function testAC16_ExitNeedsNoMerchantSignature() public {
        uint256 id = _buy(stored, 500 * U, c);
        _exit(id, 500 * U, false);
        _conserved(id);
    }

    function testAC17_BillAfterExit() public {
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Bill memory b = _bill(id, 100 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        _exit(id, 500 * U, false);
        vm.expectRevert(Vault.AccountClosed.selector);
        vault.settle(b, ms, cs);
    }

    function testAC18_ConsumeThenExitMinimum() public {
        uint256 id = _buy(stored, 500 * U, c);
        _consume(id, 200 * U, 0);
        vm.prank(c);
        vm.expectRevert(Vault.RefundBelowMinimum.selector);
        vault.exit(id, 500 * U, false);
        eq(vault.getMembership(id).remainingPrincipal, 320 * U);
        _exit(id, 300 * U, false);
        _conserved(id);
    }

    function testAC19_MultipleAccounts() public {
        uint256 a = _buy(stored, 500 * U, c);
        uint256 b = _buy(visits, 10, c2);
        _consume(a, 200 * U, 0);
        _consume(b, 0, 3);
        _exit(a, 300 * U, false);
        eq(vault.totalEscrowed(), 406 * U);
        _conserved(a);
        _conserved(b);
    }

    function testAC20_MicroDistribution() public pure {
        SettlementMath.Split memory a = SettlementMath.increment(0, 1, 5000, 5000);
        SettlementMath.Split memory b = SettlementMath.increment(1, 1, 5000, 5000);
        eq(a.merchant, 0);
        eq(a.channel, 0);
        eq(a.referral, 1);
        eq(b.channel, 1);
        eq(b.referral, 0);
        eq(SettlementMath.discounted(1, 9000), 1);
        eq(SettlementMath.discounted(11, 9000), 10);
    }

    function testAC21_HistoricalOriginalUsed() public {
        uint256 id = _buy(stored, 500 * U, c);
        _consume(id, 100 * U, 0);
        eq(vault.previewExit(id).actualTopUp, 10 * U);
    }

    function testAC22_ZeroRefundDoesNotClose() public {
        uint256 id = _buy(visits, 10, c);
        _consume(id, 0, 7);
        vm.warp(block.timestamp + 100 days);
        eq(vault.previewExit(id).refund, 0);
        eq(vault.getMembership(id).remainingPrincipal, 174 * U);
        _consume(id, 0, 1);
        eq(vault.getMembership(id).usedUnits, 8);
        _conserved(id);
    }

    function testAC23_DoubleExit() public {
        uint256 id = _buy(stored, 500 * U, c);
        _exit(id, 500 * U, false);
        vm.prank(c);
        vm.expectRevert(Vault.AccountClosed.selector);
        vault.exit(id, 0, true);
    }

    function testAC24_RefundChangedToZero() public {
        uint256 id = _buy(visits, 10, c);
        _consume(id, 0, 6);
        eq(vault.previewExit(id).refund, 52 * U);
        _consume(id, 0, 1);
        vm.prank(c);
        vm.expectRevert(Vault.RefundBelowMinimum.selector);
        vault.exit(id, 52 * U, false);
        vm.prank(c);
        vm.expectRevert(Vault.ZeroRefundNotAuthorized.selector);
        vault.exit(id, 0, false);
        eq(uint256(vault.getMembership(id).lifecycle), 0);
    }

    function testAC25_ZeroBalanceCanClose() public {
        uint256 plan = _plan(Vault.Mode.StoredValue, 10_000, 0, 0, address(0));
        uint256 id = _buy(plan, U, c);
        _consume(id, U, 0);
        token.setRejectZeroTransfers(true);
        _exit(id, 0, true);
        eq(uint256(vault.getMembership(id).lifecycle), 1);
        eq(vault.totalEscrowed(), 0);
        _conserved(id);
    }

    function testTermsChangeCannotSilentlyPurchase() public {
        Vault.PurchaseQuote memory q = vault.quotePurchase(stored, 500 * U, c);
        vm.prank(m);
        vault.setReferral(merchant, c, c2);
        vm.startPrank(c);
        token.approve(address(vault), 500 * U);
        vm.expectRevert(Vault.TermsChanged.selector);
        vault.buy(stored, 500 * U, q.termsHash);
        vm.stopPrank();
        eq(vault.membershipCount(), 0);
    }

    function testNonceCancellationAndUnauthorizedExit() public {
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Bill memory b = _bill(id, 100 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.exit(id, 0, true);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.invalidateNonce(id, 0);
        vm.prank(m);
        vault.invalidateNonce(id, 0);
        vm.expectRevert(Vault.InvalidNonce.selector);
        vault.settle(b, ms, cs);
        _consume(id, 100 * U, 0);
        vm.prank(c);
        vault.invalidateNonce(id, 2);
        _conserved(id);
    }

    function testTransferFailureRollsBackEverything() public {
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Bill memory b = _bill(id, 200 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        token.setBlocked(inviter, true);
        bytes32 before_ = keccak256(abi.encode(vault.getMembership(id)));
        uint256 merchantBefore = token.balanceOf(m);
        vm.expectRevert();
        vault.settle(b, ms, cs);
        eq(keccak256(abi.encode(vault.getMembership(id))), before_);
        eq(token.balanceOf(m), merchantBefore);
        eq(token.balanceOf(h), 0);
        _conserved(id);
        token.setBlocked(inviter, false);
        vault.settle(b, ms, cs);
        _conserved(id);
    }

    function testDomainAndTamperProtection() public {
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Bill memory b = _bill(id, 100 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        b.serviceHash = keccak256("tampered");
        vm.expectRevert(Vault.InvalidSignature.selector);
        vault.settle(b, ms, cs);
        b.serviceHash = keccak256("service");
        vm.chainId(1);
        vm.expectRevert(Vault.InvalidSignature.selector);
        vault.settle(b, ms, cs);
    }

    function testContractWalletSignaturesAreValidatedAtExecution() public {
        MockSmartWallet wallet = new MockSmartWallet(m);
        _registerUser(registry, address(wallet));
        vm.prank(address(wallet));
        (uint256 mid, address target) = factory.registerMerchant(Vault.Profile("Smart", ""), m);
        vault = Vault(target);
        Vault.PlanParams memory p;
        p.merchantId = mid;
        p.mode = Vault.Mode.StoredValue;
        p.name = "SC";
        p.minDeposit = U;
        p.discountBps = 10_000;
        vm.prank(address(wallet));
        uint256 plan = vault.createPlanVersion(p);
        uint256 id = _buy(plan, 500 * U, c);
        _consume(id, 100 * U, 0);
        Vault.Bill memory b = _bill(id, 100 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        wallet.disable();
        vm.expectRevert(Vault.InvalidSignature.selector);
        vault.settle(b, ms, cs);
        _conserved(id);
    }

    function testConsumerCanRegisterAfterPurchase() public {
        uint256 id = _buy(stored, 500 * U, c);
        vm.prank(c);
        (uint256 ownShop,) = factory.registerMerchant(Vault.Profile("Consumer Shop", ""), c);
        eq(ownShop, 2);
        eq(vault.getMembership(id).consumer, c);
    }

    function testPurchaseFailureDoesNotCreateAccount() public {
        Vault.PurchaseQuote memory q = vault.quotePurchase(stored, 500 * U, c);
        vm.prank(c);
        vm.expectRevert();
        vault.buy(stored, 500 * U, q.termsHash);
        eq(vault.membershipCount(), 0);
        eq(vault.totalEscrowed(), 0);
    }

    function testNicknameChangesDoNotInvalidateSignedConsumption() public {
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Bill memory b = _bill(id, 200 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        vm.prank(c);
        registry.updateNickname(unicode"新的用户昵称");
        vm.prank(m);
        registry.updateNickname(unicode"新的商家昵称");
        vault.settle(b, ms, cs);
        eq(vault.getMembership(id).consumer, c);
        eq(vault.getMembership(id).remainingPrincipal, 320 * U);
        _conserved(id);
    }

    function testUnregisteredWalletCannotUseBusinessWrites() public {
        address outsider = address(0xBEEF);
        Vault.PlanParams memory p;
        Vault.Bill memory bill;
        vm.startPrank(outsider);
        vm.expectRevert(Vault.UserRegistrationRequired.selector);
        vault.updateMerchantProfile(merchant, Vault.Profile("Bad", ""), outsider);
        vm.expectRevert(Vault.UserRegistrationRequired.selector);
        vault.createPlanVersion(p);
        vm.expectRevert(Vault.UserRegistrationRequired.selector);
        vault.setPlanActive(stored, false);
        vm.expectRevert(Vault.UserRegistrationRequired.selector);
        vault.setReferral(merchant, outsider, c);
        vm.expectRevert(Vault.UserRegistrationRequired.selector);
        vault.buy(stored, 500 * U, bytes32(0));
        vm.expectRevert(Vault.UserRegistrationRequired.selector);
        vault.settle(bill, "", "");
        vm.expectRevert(Vault.UserRegistrationRequired.selector);
        vault.invalidateNonce(1, 0);
        vm.expectRevert(Vault.UserRegistrationRequired.selector);
        vault.exit(1, 0, true);
        vm.stopPrank();
        eq(vault.membershipCount(), 0);
        eq(vault.totalEscrowed(), 0);
    }

    function testMerchantPermissionsAreIsolated() public {
        vm.prank(c);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.setPlanActive(stored, false);
        vm.prank(c);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.setReferral(merchant, c, c2);
        vm.prank(c);
        vm.expectRevert(Vault.Unauthorized.selector);
        vault.updateMerchantProfile(merchant, Vault.Profile("Bad", ""), c);
    }

    function testMicroDistributionOnLiveAccount() public {
        uint256 plan = _plan(Vault.Mode.StoredValue, 10_000, 5000, 5000, h);
        uint256 id = _buy(plan, U, c);
        _consume(id, 1, 0);
        _consume(id, 1, 0);
        eq(token.balanceOf(h), 1);
        eq(token.balanceOf(inviter), 1);
        eq(vault.getMembership(id).merchantPaid, 0);
        _conserved(id);
    }

    function testExitTransferFailureRollsBackClosure() public {
        uint256 id = _buy(stored, 500 * U, c);
        _consume(id, 200 * U, 0);
        token.setBlocked(inviter, true);
        bytes32 before_ = keccak256(abi.encode(vault.getMembership(id)));
        vm.prank(c);
        vm.expectRevert();
        vault.exit(id, 300 * U, false);
        eq(keccak256(abi.encode(vault.getMembership(id))), before_);
        eq(token.balanceOf(c), 9500 * U);
        _conserved(id);
    }

    function testReentryIsRejectedBeforeAnySecondSettlement() public {
        CallbackToken callbackToken = new CallbackToken();
        token = callbackToken;
        factory = new Factory(address(token), address(registry));
        vm.prank(m);
        address target;
        (merchant, target) = factory.registerMerchant(Vault.Profile("Callback fixture", ""), m);
        vault = Vault(target);
        stored = _plan(Vault.Mode.StoredValue, 9000, 0, 0, address(0));
        token.mint(c, 500 * U);
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Bill memory b = _bill(id, 200 * U, 0);
        (bytes memory ms, bytes memory cs) = _sign(b);
        callbackToken.setCallback(address(vault), abi.encodeCall(Vault.settle, (b, ms, cs)));
        vault.settle(b, ms, cs);
        eq(
            uint256(uint32(callbackToken.observedError())),
            uint256(uint32(ReentrancyGuard.ReentrancyGuardReentrantCall.selector))
        );
        eq(vault.getMembership(id).nextNonce, 1);
        eq(vault.getMembership(id).remainingPrincipal, 320 * U);
        _conserved(id);
    }

    function testPaginationAndInvalidIdentity() public {
        _buy(stored, 500 * U, c);
        _buy(visits, 10, c);
        (uint256[] memory first, uint256 next) = vault.listConsumerMemberships(c, 0, 1);
        eq(first[0], 1);
        eq(next, 1);
        (uint256[] memory second,) = vault.listConsumerMemberships(c, next, 1);
        eq(second[0], 2);
        vm.expectRevert(Vault.InvalidParameters.selector);
        vault.listMerchantPlans(merchant, 0, 101);
        vm.expectRevert(Vault.NotFound.selector);
        vault.getMembership(999);
    }

    function testPlanRevisionsPreservePurchasedTerms() public {
        uint256 id = _buy(stored, 500 * U, c);
        vm.prank(m);
        vault.updateMerchantProfile(merchant, Vault.Profile("Revised", ""), c2);
        Vault.PlanParams memory p;
        p.merchantId = merchant;
        p.previousVersionId = stored;
        p.name = "Version 2";
        p.minDeposit = 500 * U;
        p.discountBps = 8000;
        vm.prank(m);
        uint256 next = vault.createPlanVersion(p);
        eq(vault.getPlanVersion(next).version, 2);
        eq(vault.getPlanVersion(next).planId, vault.getPlanVersion(stored).planId);
        eq(vault.getMembership(id).discountBps, 9000);
        eq(vault.getMembership(id).merchantPayout, m);
        uint256 newer = _buy(next, 500 * U, c);
        eq(vault.getMembership(newer).discountBps, 8000);
        eq(vault.getMembership(newer).merchantPayout, c2);
        vm.prank(m);
        vm.expectRevert(Vault.InvalidParameters.selector);
        vault.createPlanVersion(p);
        _conserved(id);
        _conserved(newer);
    }

    function testDifferentMerchantsCannotShareAccountPrincipal() public {
        uint256 a = _buy(stored, 500 * U, c);
        Vault first = vault;
        vm.prank(c2);
        (uint256 mid, address target) = factory.registerMerchant(Vault.Profile("Second Shop", ""), c2);
        vault = Vault(target);
        Vault.PlanParams memory p;
        p.merchantId = mid;
        p.name = "Separate";
        p.minDeposit = U;
        p.discountBps = 10000;
        vm.prank(c2);
        uint256 plan = vault.createPlanVersion(p);
        uint256 b = _buy(plan, 100 * U, c);
        Vault.Bill memory bill = _bill(b, 40 * U, 0);
        bytes32 digest = vault.billDigest(bill);
        vault.settle(bill, _sig(C2PK, digest), _sig(CPK, digest));
        eq(token.balanceOf(address(first)), 500 * U);
        eq(token.balanceOf(address(vault)), 60 * U);
        _exit(b, 60 * U, false);
        _conserved(b);
        eq(token.balanceOf(address(vault)), 0);
        vault = first;
        _consume(a, 200 * U, 0);
        eq(vault.getMembership(a).remainingPrincipal, 320 * U);
        _exit(a, 300 * U, false);
        eq(vault.totalEscrowed(), 0);
        eq(token.balanceOf(address(factory)), 0);
        _conserved(a);
    }

    function testDeadlineBoundariesAreEnforced() public {
        uint256 id = _buy(stored, 500 * U, c);
        Vault.Bill memory b = _bill(id, 100 * U, 0);
        b.issuedAt = block.timestamp - 1;
        b.deadline = block.timestamp;
        (bytes memory ms, bytes memory cs) = _sign(b);
        vault.settle(b, ms, cs);
        b = _bill(id, 100 * U, 0);
        b.deadline = b.issuedAt + 901;
        vm.expectRevert(Vault.InvalidTime.selector);
        vault.previewSettlement(b);
        b = _bill(id, 100 * U, 0);
        b.issuedAt++;
        b.deadline++;
        vm.expectRevert(Vault.InvalidTime.selector);
        vault.previewSettlement(b);
        _conserved(id);
    }

    function testFuzz_MathConservesAndIsMonotonic(uint96 start, uint64 amount, uint16 rawC, uint16 rawI) public pure {
        uint256 cb = uint256(rawC) % 10_001;
        uint256 rb = uint256(rawI) % (10_001 - cb);
        SettlementMath.Split memory a = SettlementMath.increment(start, amount, cb, rb);
        eq(a.merchant + a.channel + a.referral, amount);
        SettlementMath.Split memory before_ = SettlementMath.targets(start, cb, rb);
        SettlementMath.Split memory after_ = SettlementMath.targets(uint256(start) + amount, cb, rb);
        eq(before_.merchant + a.merchant, after_.merchant);
        eq(before_.channel + a.channel, after_.channel);
        eq(before_.referral + a.referral, after_.referral);
    }
}
