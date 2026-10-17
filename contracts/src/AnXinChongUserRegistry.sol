// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Shared on-chain profiles. Wallets own their nickname; handles are permanent.
/// No administrator, upgrades, transfers, deletions or funds management.
contract AnXinChongUserRegistry {
    struct Profile {
        string handle;
        string nickname;
    }

    mapping(address => Profile) private _profiles;
    mapping(bytes32 => address) private _handleOwners;
    uint256 public userCount;

    error AlreadyRegistered();
    error NotRegistered();
    error InvalidHandle();
    error HandleTaken();
    error InvalidNickname();

    event UserRegistered(address indexed account, bytes32 indexed handleHash, string handle, string nickname);
    event NicknameUpdated(address indexed account, string nickname);

    function registerUser(string calldata handle, string calldata nickname) external {
        if (bytes(_profiles[msg.sender].handle).length != 0) revert AlreadyRegistered();
        _validateHandle(handle);
        _validateNickname(nickname);
        bytes32 key = keccak256(bytes(handle));
        if (_handleOwners[key] != address(0)) revert HandleTaken();
        _profiles[msg.sender] = Profile(handle, nickname);
        _handleOwners[key] = msg.sender;
        ++userCount;
        emit UserRegistered(msg.sender, key, handle, nickname);
    }

    function updateNickname(string calldata nickname) external {
        if (bytes(_profiles[msg.sender].handle).length == 0) revert NotRegistered();
        _validateNickname(nickname);
        _profiles[msg.sender].nickname = nickname;
        emit NicknameUpdated(msg.sender, nickname);
    }

    function getProfile(address account) external view returns (Profile memory) {
        return _profiles[account];
    }

    function isRegistered(address account) external view returns (bool) {
        return bytes(_profiles[account].handle).length != 0;
    }

    function resolveHandle(string calldata handle) external view returns (address) {
        _validateHandle(handle);
        return _handleOwners[keccak256(bytes(handle))];
    }

    function _validateHandle(string calldata handle) private pure {
        bytes memory value = bytes(handle);
        if (value.length < 3 || value.length > 24) revert InvalidHandle();
        for (uint256 i; i < value.length; ++i) {
            bytes1 c = value[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f)) revert InvalidHandle();
        }
    }

    function _validateNickname(string calldata nickname) private pure {
        // UTF-8 byte limit, not a character count. Nicknames are display text, never identifiers.
        bytes memory value = bytes(nickname);
        if (value.length == 0 || value.length > 96) revert InvalidNickname();
        bool visible;
        for (uint256 i; i < value.length; ++i) {
            uint8 c = uint8(value[i]);
            if (c < 0x20 || c == 0x7f) revert InvalidNickname();
            if (c != 0x20) visible = true;
        }
        if (!visible) revert InvalidNickname();
    }
}
