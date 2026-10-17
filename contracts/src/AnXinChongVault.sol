// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SettlementMath} from "./libraries/SettlementMath.sol";
import {AnXinChongUserRegistry} from "./AnXinChongUserRegistry.sol";

/// @notice Immutable single-merchant, single-asset escrow. No administrator or upgrade mechanism.
contract AnXinChongVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Mode {
        StoredValue,
        VisitCount
    }
    enum Lifecycle {
        Active,
        Exited
    }
    enum Role {
        Merchant,
        Channel,
        Referral
    }

    struct Profile {
        string name;
        string description;
    }

    struct Merchant {
        address owner;
        address defaultPayout;
        string name;
        string description;
    }

    struct MerchantStats {
        uint256 escrowed;
        uint256 income;
        uint256 memberships;
    }

    struct PlanParams {
        uint256 merchantId;
        uint256 previousVersionId;
        Mode mode;
        string name;
        string description;
        uint256 minDeposit;
        uint256 discountBps;
        uint256 minUnits;
        uint256 listUnitPrice;
        uint256 saleUnitPrice;
        address channelRecipient;
        uint256 channelBps;
        uint256 referralBps;
    }

    struct PlanVersion {
        uint256 planId;
        uint256 version;
        uint256 previousVersionId;
        uint256 merchantId;
        Mode mode;
        bool active;
        address merchantSigner;
        address merchantPayout;
        address channelRecipient;
        uint256 channelBps;
        uint256 referralBps;
        uint256 minDeposit;
        uint256 discountBps;
        uint256 minUnits;
        uint256 listUnitPrice;
        uint256 saleUnitPrice;
        string name;
        string description;
    }

    struct PurchaseQuote {
        uint256 principal;
        uint256 units;
        address referralRecipient;
        uint256 channelBps;
        uint256 referralBps;
        bytes32 termsHash;
    }

    struct Membership {
        uint256 merchantId;
        uint256 planVersionId;
        address consumer;
        Mode mode;
        Lifecycle lifecycle;
        address merchantSigner;
        address merchantPayout;
        address channelRecipient;
        address referralRecipient;
        uint256 channelBps;
        uint256 referralBps;
        uint256 discountBps;
        uint256 listUnitPrice;
        uint256 saleUnitPrice;
        uint256 initialPrincipal;
        uint256 remainingPrincipal;
        uint256 purchasedUnits;
        uint256 usedUnits;
        uint256 totalOriginalValue;
        uint256 totalActualSpend;
        uint256 totalReleased;
        uint256 merchantPaid;
        uint256 channelPaid;
        uint256 referralPaid;
        uint256 refundedAmount;
        uint256 exitTopUp;
        uint256 forfeitedUnits;
        uint256 exitedAt;
        uint256 nextNonce;
        bytes32 termsHash;
    }

    struct Bill {
        uint256 membershipId;
        bytes32 termsHash;
        address merchantSigner;
        address consumer;
        uint8 mode;
        uint256 originalValue;
        uint256 discountBps;
        uint256 debitAmount;
        uint256 units;
        bytes32 orderId;
        uint256 nonce;
        uint256 issuedAt;
        uint256 deadline;
        bytes32 serviceHash;
    }

    struct ExitQuote {
        uint256 balance;
        uint256 compensation;
        uint256 actualTopUp;
        uint256 refund;
        uint256 forfeitedUnits;
        SettlementMath.Split split;
    }

    struct SettlementPreview {
        uint256 original;
        uint256 debit;
        uint256 remainingPrincipal;
        uint256 remainingUnits;
        uint256 refundableAfter;
        SettlementMath.Split split;
    }

    bytes32 public constant BILL_TYPEHASH = keccak256(
        "Bill(uint256 membershipId,bytes32 termsHash,address merchantSigner,address consumer,uint8 mode,uint256 originalValue,uint256 discountBps,uint256 debitAmount,uint256 units,bytes32 orderId,uint256 nonce,uint256 issuedAt,uint256 deadline,bytes32 serviceHash)"
    );
    uint256 public constant MAX_BILL_LIFETIME = 15 minutes;
    uint256 public constant MAX_PAGE_SIZE = 100;
    IERC20 public immutable asset;
    AnXinChongUserRegistry public immutable userRegistry;
    address public immutable factory;
    uint256 public immutable merchantId;
    uint256 public planCount;
    uint256 public planVersionCount;
    uint256 public membershipCount;
    uint256 public totalEscrowed;
    mapping(uint256 => uint256) public latestVersion;
    mapping(uint256 => mapping(address => address)) public referralOf;
    Merchant private _merchantData;
    mapping(uint256 => PlanVersion) private _plans;
    mapping(uint256 => Membership) private _memberships;
    mapping(uint256 => MerchantStats) private _merchantStats;
    mapping(address => uint256) public channelIncome;
    mapping(address => uint256) public referralIncome;
    mapping(uint256 => uint256[]) private _merchantPlans;
    mapping(address => uint256[]) private _consumerMemberships;
    mapping(uint256 => uint256[]) private _merchantMemberships;

    error NotFound();
    error Unauthorized();
    error InvalidAddress();
    error InvalidParameters();
    error PlanInactive();
    error TermsChanged();
    error AccountClosed();
    error InvalidNonce();
    error InvalidTime();
    error InvalidSignature();
    error BillMismatch();
    error InsufficientPrincipal();
    error InsufficientUnits();
    error RefundBelowMinimum();
    error ZeroRefundNotAuthorized();
    error UnsupportedAsset();
    error InvalidRegistry();
    error UserRegistrationRequired();

    modifier registeredUser() {
        if (!userRegistry.isRegistered(msg.sender)) revert UserRegistrationRequired();
        _;
    }

    event MerchantUpdated(uint256 indexed merchantId, address indexed owner, address defaultPayout);
    event PlanVersionCreated(
        uint256 indexed merchantId,
        uint256 indexed planId,
        uint256 indexed planVersionId,
        uint256 previousVersionId,
        Mode mode
    );
    event PlanStatusChanged(uint256 indexed merchantId, uint256 indexed planVersionId, bool active);
    event ReferralSet(uint256 indexed merchantId, address indexed consumer, address indexed referrer);
    event MembershipPurchased(
        uint256 indexed membershipId,
        uint256 indexed merchantId,
        address indexed consumer,
        uint256 planVersionId,
        uint256 principal,
        uint256 units,
        bytes32 termsHash
    );
    event ConsumptionSettled(
        uint256 indexed membershipId,
        uint256 indexed merchantId,
        address indexed consumer,
        bytes32 billHash,
        bytes32 orderId,
        uint256 nonce,
        uint256 originalValue,
        uint256 debitAmount,
        uint256 units,
        bytes32 serviceHash,
        uint256 remainingPrincipal
    );
    event MembershipExited(
        uint256 indexed membershipId,
        uint256 indexed merchantId,
        address indexed consumer,
        uint256 balance,
        uint256 compensation,
        uint256 actualTopUp,
        uint256 refund,
        uint256 forfeitedUnits
    );
    event SplitPaid(
        uint256 indexed membershipId,
        address indexed recipient,
        Role indexed role,
        bytes32 operationId,
        uint256 released,
        uint256 amount
    );
    event NonceInvalidated(
        uint256 indexed membershipId, address indexed caller, uint256 previousNonce, uint256 nextNonce
    );

    constructor(address token, address registry, uint256 id, address owner, Profile memory profile, address payout)
        EIP712("AnXinChong", "1")
    {
        if (token.code.length == 0 || IERC20Metadata(token).decimals() != 6) revert UnsupportedAsset();
        asset = IERC20(token);
        if (registry.code.length == 0) revert InvalidRegistry();
        userRegistry = AnXinChongUserRegistry(registry);
        if (!userRegistry.isRegistered(owner)) revert UserRegistrationRequired();
        factory = msg.sender;
        merchantId = id;
        if (id == 0) revert InvalidParameters();
        _validAddress(owner);
        _validAddress(payout);
        _validProfile(profile);
        _merchantData = Merchant(owner, payout, profile.name, profile.description);
    }

    function updateMerchantProfile(uint256 id, Profile calldata profile, address payout) external registeredUser {
        Merchant storage m = _ownedMerchant(id);
        _validAddress(payout);
        _validProfile(profile);
        m.defaultPayout = payout;
        m.name = profile.name;
        m.description = profile.description;
        emit MerchantUpdated(id, msg.sender, payout);
    }

    function createPlanVersion(PlanParams calldata p) external registeredUser returns (uint256 id) {
        Merchant storage merchant = _ownedMerchant(p.merchantId);
        if (bytes(p.name).length == 0 || bytes(p.name).length > 96 || bytes(p.description).length > 512) {
            revert InvalidParameters();
        }
        if (p.channelBps > 10_000 || p.referralBps > 10_000 || p.channelBps + p.referralBps > 10_000) {
            revert InvalidParameters();
        }
        if (p.channelRecipient != address(0)) _validAddress(p.channelRecipient);
        if (p.mode == Mode.StoredValue) {
            if (
                p.minDeposit == 0 || p.discountBps == 0 || p.discountBps > 10_000 || p.minUnits != 0
                    || p.listUnitPrice != 0 || p.saleUnitPrice != 0
            ) revert InvalidParameters();
        } else {
            if (
                p.minUnits == 0 || p.saleUnitPrice == 0 || p.listUnitPrice < p.saleUnitPrice || p.minDeposit != 0
                    || p.discountBps != 0
            ) revert InvalidParameters();
        }
        uint256 planId;
        uint256 version = 1;
        if (p.previousVersionId == 0) {
            planId = ++planCount;
        } else {
            PlanVersion storage previous = _plan(p.previousVersionId);
            if (previous.merchantId != p.merchantId || latestVersion[previous.planId] != p.previousVersionId) {
                revert InvalidParameters();
            }
            planId = previous.planId;
            version = previous.version + 1;
        }
        id = ++planVersionCount;
        PlanVersion storage v = _plans[id];
        v.planId = planId;
        v.version = version;
        v.previousVersionId = p.previousVersionId;
        v.merchantId = p.merchantId;
        v.mode = p.mode;
        v.active = true;
        v.merchantSigner = merchant.owner;
        v.merchantPayout = merchant.defaultPayout;
        v.channelRecipient = p.channelRecipient;
        v.channelBps = p.channelRecipient == address(0) ? 0 : p.channelBps;
        v.referralBps = p.referralBps;
        v.minDeposit = p.minDeposit;
        v.discountBps = p.discountBps;
        v.minUnits = p.minUnits;
        v.listUnitPrice = p.listUnitPrice;
        v.saleUnitPrice = p.saleUnitPrice;
        v.name = p.name;
        v.description = p.description;
        latestVersion[planId] = id;
        _merchantPlans[p.merchantId].push(id);
        emit PlanVersionCreated(p.merchantId, planId, id, p.previousVersionId, p.mode);
    }

    function setPlanActive(uint256 id, bool active) external registeredUser {
        PlanVersion storage p = _plan(id);
        _ownedMerchant(p.merchantId);
        p.active = active;
        emit PlanStatusChanged(p.merchantId, id, active);
    }

    function setReferral(uint256 id, address consumer, address referrer) external registeredUser {
        _ownedMerchant(id);
        _validAddress(consumer);
        if (referrer != address(0)) _validAddress(referrer);
        referralOf[id][consumer] = referrer;
        emit ReferralSet(id, consumer, referrer);
    }

    function quotePurchase(uint256 planVersionId, uint256 amountOrUnits, address consumer)
        public
        view
        returns (PurchaseQuote memory q)
    {
        _validAddress(consumer);
        PlanVersion storage p = _plan(planVersionId);
        if (!p.active) revert PlanInactive();
        if (p.mode == Mode.StoredValue) {
            if (amountOrUnits < p.minDeposit) revert InvalidParameters();
            q.principal = amountOrUnits;
        } else {
            if (amountOrUnits < p.minUnits) revert InvalidParameters();
            q.units = amountOrUnits;
            q.principal = amountOrUnits * p.saleUnitPrice;
        }
        q.referralRecipient = referralOf[p.merchantId][consumer];
        q.channelBps = p.channelBps;
        q.referralBps = q.referralRecipient == address(0) ? 0 : p.referralBps;
        q.termsHash = keccak256(
            abi.encode(block.chainid, address(this), address(asset), planVersionId, consumer, amountOrUnits, p, q)
        );
    }

    function buy(uint256 planVersionId, uint256 amountOrUnits, bytes32 expectedTermsHash)
        external
        nonReentrant
        registeredUser
        returns (uint256 id)
    {
        PurchaseQuote memory q = quotePurchase(planVersionId, amountOrUnits, msg.sender);
        if (q.termsHash != expectedTermsHash) revert TermsChanged();
        PlanVersion storage p = _plans[planVersionId];
        id = ++membershipCount;
        Membership storage m = _memberships[id];
        m.merchantId = p.merchantId;
        m.planVersionId = planVersionId;
        m.consumer = msg.sender;
        m.mode = p.mode;
        m.merchantSigner = p.merchantSigner;
        m.merchantPayout = p.merchantPayout;
        m.channelRecipient = p.channelRecipient;
        m.referralRecipient = q.referralRecipient;
        m.channelBps = q.channelBps;
        m.referralBps = q.referralBps;
        m.discountBps = p.discountBps;
        m.listUnitPrice = p.listUnitPrice;
        m.saleUnitPrice = p.saleUnitPrice;
        m.initialPrincipal = q.principal;
        m.remainingPrincipal = q.principal;
        m.purchasedUnits = q.units;
        m.termsHash = q.termsHash;
        _consumerMemberships[msg.sender].push(id);
        _merchantMemberships[p.merchantId].push(id);
        _merchantStats[p.merchantId].escrowed += q.principal;
        _merchantStats[p.merchantId].memberships++;
        totalEscrowed += q.principal;
        uint256 before_ = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), q.principal);
        if (asset.balanceOf(address(this)) - before_ != q.principal) revert UnsupportedAsset();
        emit MembershipPurchased(id, p.merchantId, msg.sender, planVersionId, q.principal, q.units, q.termsHash);
    }

    function billDigest(Bill calldata bill) public view returns (bytes32) {
        // Bill has only static fields, so encoding the tuple is equivalent to encoding its fields.
        return _hashTypedDataV4(keccak256(abi.encode(BILL_TYPEHASH, bill)));
    }

    function previewSettlement(Bill calldata bill) public view returns (SettlementPreview memory q) {
        Membership storage m = _active(bill.membershipId);
        if (bill.nonce != m.nextNonce) revert InvalidNonce();
        if (
            bill.issuedAt > block.timestamp || bill.deadline < block.timestamp || bill.deadline <= bill.issuedAt
                || bill.deadline - bill.issuedAt > MAX_BILL_LIFETIME
        ) revert InvalidTime();
        if (
            bill.termsHash != m.termsHash || bill.merchantSigner != m.merchantSigner || bill.consumer != m.consumer
                || bill.mode != uint8(m.mode)
        ) revert BillMismatch();
        if (m.mode == Mode.StoredValue) {
            if (bill.units != 0 || bill.originalValue == 0 || bill.discountBps != m.discountBps) revert BillMismatch();
            q.original = bill.originalValue;
            q.debit = SettlementMath.discounted(q.original, m.discountBps);
        } else {
            if (bill.units == 0 || bill.discountBps != 0) revert BillMismatch();
            if (bill.units > m.purchasedUnits - m.usedUnits) revert InsufficientUnits();
            q.original = bill.units * m.listUnitPrice;
            q.debit = bill.units * m.saleUnitPrice;
            q.remainingUnits = m.purchasedUnits - m.usedUnits - bill.units;
        }
        if (bill.originalValue != q.original || bill.debitAmount != q.debit) revert BillMismatch();
        if (q.debit == 0 || q.debit > m.remainingPrincipal) revert InsufficientPrincipal();
        q.remainingPrincipal = m.remainingPrincipal - q.debit;
        uint256 compensation = m.totalOriginalValue + q.original - m.totalActualSpend - q.debit;
        q.refundableAfter = q.remainingPrincipal - Math.min(q.remainingPrincipal, compensation);
        q.split = SettlementMath.increment(m.totalReleased, q.debit, m.channelBps, m.referralBps);
    }

    function settle(Bill calldata bill, bytes calldata merchantSignature, bytes calldata consumerSignature)
        external
        nonReentrant
        registeredUser
    {
        SettlementPreview memory q = previewSettlement(bill);
        Membership storage m = _memberships[bill.membershipId];
        bytes32 digest = billDigest(bill);
        if (
            !SignatureChecker.isValidSignatureNow(m.merchantSigner, digest, merchantSignature)
                || !SignatureChecker.isValidSignatureNow(m.consumer, digest, consumerSignature)
        ) revert InvalidSignature();
        m.nextNonce++;
        m.remainingPrincipal = q.remainingPrincipal;
        m.totalOriginalValue += q.original;
        m.totalActualSpend += q.debit;
        m.usedUnits += bill.units;
        totalEscrowed -= q.debit;
        _merchantStats[m.merchantId].escrowed -= q.debit;
        _release(bill.membershipId, m, q.debit, digest);
        emit ConsumptionSettled(
            bill.membershipId,
            m.merchantId,
            m.consumer,
            digest,
            bill.orderId,
            bill.nonce,
            q.original,
            q.debit,
            bill.units,
            bill.serviceHash,
            m.remainingPrincipal
        );
    }

    function invalidateNonce(uint256 id, uint256 expectedNonce) external registeredUser {
        Membership storage m = _active(id);
        if (msg.sender != m.consumer && msg.sender != m.merchantSigner) revert Unauthorized();
        if (m.nextNonce != expectedNonce) revert InvalidNonce();
        m.nextNonce++;
        emit NonceInvalidated(id, msg.sender, expectedNonce, m.nextNonce);
    }

    function previewExit(uint256 id) public view returns (ExitQuote memory q) {
        Membership storage m = _active(id);
        q.balance = m.remainingPrincipal;
        q.compensation = m.totalOriginalValue - m.totalActualSpend;
        q.actualTopUp = Math.min(q.balance, q.compensation);
        q.refund = q.balance - q.actualTopUp;
        q.forfeitedUnits = m.purchasedUnits - m.usedUnits;
        q.split = SettlementMath.increment(m.totalReleased, q.actualTopUp, m.channelBps, m.referralBps);
    }

    function exit(uint256 id, uint256 minRefund, bool allowZeroRefund) external nonReentrant registeredUser {
        Membership storage m = _active(id);
        if (msg.sender != m.consumer) revert Unauthorized();
        ExitQuote memory q = previewExit(id);
        if (q.refund < minRefund) revert RefundBelowMinimum();
        if (q.refund == 0 && !allowZeroRefund) revert ZeroRefundNotAuthorized();
        m.lifecycle = Lifecycle.Exited;
        m.remainingPrincipal = 0;
        m.refundedAmount = q.refund;
        m.exitTopUp = q.actualTopUp;
        m.forfeitedUnits = q.forfeitedUnits;
        m.exitedAt = block.timestamp;
        totalEscrowed -= q.balance;
        _merchantStats[m.merchantId].escrowed -= q.balance;
        _release(id, m, q.actualTopUp, keccak256(abi.encode("EXIT", id)));
        if (q.refund > 0) asset.safeTransfer(m.consumer, q.refund);
        emit MembershipExited(
            id, m.merchantId, m.consumer, q.balance, q.compensation, q.actualTopUp, q.refund, q.forfeitedUnits
        );
    }

    function getMerchant(uint256 id) external view returns (Merchant memory) {
        return _merchant(id);
    }

    function getPlanVersion(uint256 id) external view returns (PlanVersion memory) {
        return _plan(id);
    }

    function getMembership(uint256 id) external view returns (Membership memory) {
        return _membership(id);
    }

    function getMerchantStats(uint256 id) external view returns (MerchantStats memory) {
        _merchant(id);
        return _merchantStats[id];
    }

    function getRecipientStats(address recipient) external view returns (uint256 channel, uint256 referral) {
        return (channelIncome[recipient], referralIncome[recipient]);
    }

    function listMerchantPlans(uint256 id, uint256 cursor, uint256 limit)
        external
        view
        returns (uint256[] memory, uint256)
    {
        _merchant(id);
        return _page(_merchantPlans[id], cursor, limit);
    }

    function listConsumerMemberships(address consumer, uint256 cursor, uint256 limit)
        external
        view
        returns (uint256[] memory, uint256)
    {
        return _page(_consumerMemberships[consumer], cursor, limit);
    }

    function listMerchantMemberships(uint256 id, uint256 cursor, uint256 limit)
        external
        view
        returns (uint256[] memory, uint256)
    {
        _merchant(id);
        return _page(_merchantMemberships[id], cursor, limit);
    }

    function _release(uint256 id, Membership storage m, uint256 amount, bytes32 operationId) private {
        SettlementMath.Split memory s = SettlementMath.increment(m.totalReleased, amount, m.channelBps, m.referralBps);
        m.totalReleased += amount;
        m.merchantPaid += s.merchant;
        m.channelPaid += s.channel;
        m.referralPaid += s.referral;
        _merchantStats[m.merchantId].income += s.merchant;
        channelIncome[m.channelRecipient] += s.channel;
        referralIncome[m.referralRecipient] += s.referral;
        _pay(id, m.merchantPayout, Role.Merchant, operationId, amount, s.merchant);
        _pay(id, m.channelRecipient, Role.Channel, operationId, amount, s.channel);
        _pay(id, m.referralRecipient, Role.Referral, operationId, amount, s.referral);
    }

    function _pay(uint256 id, address recipient, Role role, bytes32 operationId, uint256 released, uint256 amount)
        private
    {
        if (amount == 0) return;
        asset.safeTransfer(recipient, amount);
        emit SplitPaid(id, recipient, role, operationId, released, amount);
    }

    function _merchant(uint256 id) private view returns (Merchant storage m) {
        if (id != merchantId) revert NotFound();
        m = _merchantData;
    }

    function _ownedMerchant(uint256 id) private view returns (Merchant storage m) {
        m = _merchant(id);
        if (m.owner != msg.sender) revert Unauthorized();
    }

    function _plan(uint256 id) private view returns (PlanVersion storage p) {
        p = _plans[id];
        if (p.merchantId == 0) revert NotFound();
    }

    function _membership(uint256 id) private view returns (Membership storage m) {
        m = _memberships[id];
        if (m.consumer == address(0)) revert NotFound();
    }

    function _active(uint256 id) private view returns (Membership storage m) {
        m = _membership(id);
        if (m.lifecycle == Lifecycle.Exited) revert AccountClosed();
    }

    function _validAddress(address a) private view {
        if (a == address(0) || a == address(this) || a == factory) revert InvalidAddress();
    }

    function _validProfile(Profile memory p) private pure {
        if (bytes(p.name).length == 0 || bytes(p.name).length > 96 || bytes(p.description).length > 512) {
            revert InvalidParameters();
        }
    }

    function _page(uint256[] storage source, uint256 cursor, uint256 limit)
        private
        view
        returns (uint256[] memory items, uint256 next)
    {
        if (limit == 0 || limit > MAX_PAGE_SIZE || cursor > source.length) revert InvalidParameters();
        next = Math.min(source.length, cursor + limit);
        items = new uint256[](next - cursor);
        for (uint256 i; i < items.length; ++i) {
            items[i] = source[cursor + i];
        }
    }
}
