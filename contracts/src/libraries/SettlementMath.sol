// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

library SettlementMath {
    uint256 internal constant BPS = 10_000;

    struct Split {
        uint256 merchant;
        uint256 channel;
        uint256 referral;
    }

    function discounted(uint256 original, uint256 bps) internal pure returns (uint256) {
        return Math.mulDiv(original, bps, BPS, Math.Rounding.Ceil);
    }

    function targets(uint256 released, uint256 channelBps, uint256 referralBps) internal pure returns (Split memory s) {
        uint256 feeBps = channelBps + referralBps;
        if (feeBps == 0) return Split(released, 0, 0);
        uint256 fees = Math.mulDiv(released, feeBps, BPS);
        s.channel = Math.mulDiv(fees, channelBps, feeBps);
        s.referral = fees - s.channel;
        s.merchant = released - fees;
    }

    function increment(uint256 released, uint256 amount, uint256 channelBps, uint256 referralBps)
        internal
        pure
        returns (Split memory s)
    {
        Split memory before_ = targets(released, channelBps, referralBps);
        s = targets(released + amount, channelBps, referralBps);
        s.merchant -= before_.merchant;
        s.channel -= before_.channel;
        s.referral -= before_.referral;
    }
}
