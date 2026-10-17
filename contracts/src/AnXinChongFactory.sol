// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AnXinChongVault} from "./AnXinChongVault.sol";
import {AnXinChongUserRegistry} from "./AnXinChongUserRegistry.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Permissionless directory. Each merchant gets a complete immutable vault, not a proxy.
/// The factory never receives purchase funds and has no authority over created vaults.
contract AnXinChongFactory is ReentrancyGuard {
    struct MerchantInfo {
        address vault;
        uint256 deploymentBlock;
        address owner;
        address defaultPayout;
        string name;
        string description;
    }

    address public immutable asset;
    AnXinChongUserRegistry public immutable userRegistry;
    uint256 public merchantCount;
    mapping(address => uint256) public merchantOf;
    mapping(uint256 => address) public vaultOf;
    mapping(address => uint256) public merchantIdOfVault;
    mapping(uint256 => uint256) public vaultDeploymentBlock;

    error AlreadyRegistered();
    error NotFound();
    error InvalidParameters();
    error UnsupportedAsset();
    error InvalidRegistry();
    error UserRegistrationRequired();
    event MerchantVaultCreated(uint256 indexed merchantId, address indexed owner, address indexed vault);

    constructor(address token, address registry) {
        if (token.code.length == 0 || IERC20Metadata(token).decimals() != 6) revert UnsupportedAsset();
        if (registry.code.length == 0) revert InvalidRegistry();
        asset = token;
        userRegistry = AnXinChongUserRegistry(registry);
        userRegistry.isRegistered(address(this));
    }

    function registerMerchant(AnXinChongVault.Profile calldata profile, address payout)
        external
        nonReentrant
        returns (uint256 id, address vault)
    {
        if (!userRegistry.isRegistered(msg.sender)) revert UserRegistrationRequired();
        if (merchantOf[msg.sender] != 0) revert AlreadyRegistered();
        if (payout == address(this)) revert InvalidParameters();
        id = ++merchantCount;
        vault = address(new AnXinChongVault(asset, address(userRegistry), id, msg.sender, profile, payout));
        merchantOf[msg.sender] = id;
        vaultOf[id] = vault;
        merchantIdOfVault[vault] = id;
        vaultDeploymentBlock[id] = block.number;
        emit MerchantVaultCreated(id, msg.sender, vault);
    }

    function getMerchant(uint256 id) external view returns (MerchantInfo memory info) {
        address vault = vaultOf[id];
        if (vault == address(0)) revert NotFound();
        AnXinChongVault.Merchant memory m = AnXinChongVault(vault).getMerchant(id);
        return MerchantInfo(vault, vaultDeploymentBlock[id], m.owner, m.defaultPayout, m.name, m.description);
    }

    function listMerchants(uint256 cursor, uint256 limit) external view returns (uint256[] memory ids, uint256 next) {
        if (limit == 0 || limit > 100 || cursor > merchantCount) revert InvalidParameters();
        uint256 count = merchantCount - cursor;
        if (count > limit) count = limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = cursor + i + 1;
        }
        next = cursor + count;
    }
}
