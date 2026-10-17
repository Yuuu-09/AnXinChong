// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local testing only; never presented as Circle-issued USDC.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;
    bool public rejectZeroTransfers;
    constructor() ERC20("Mock USDC - Local Testing", "MockUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function setRejectZeroTransfers(bool value) external {
        rejectZeroTransfers = value;
    }

    function _update(address from, address to, uint256 amount) internal virtual override {
        require(!blocked[to] && !blocked[from], "MOCK_BLOCKED");
        require(!rejectZeroTransfers || amount != 0, "MOCK_ZERO_TRANSFER");
        super._update(from, to, amount);
    }
}
