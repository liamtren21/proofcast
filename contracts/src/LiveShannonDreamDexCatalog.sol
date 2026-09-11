// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IProofCastMarketCatalog} from "./ProofCastRegistry.sol";
import {IPCModuleState, IPCPoolState, IPCMarket} from "./ProofCastDreamDexAdapter.sol";

/// @notice Reads current native bindings instead of pinning one expiring market.
contract LiveShannonDreamDexCatalog is IProofCastMarketCatalog {
    address public immutable module;
    address public immutable collateral;
    address public immutable outcomes;
    address public immutable settlement;
    constructor(address module_,address collateral_,address outcomes_,address settlement_) {
        require(module_.code.length>0 && collateral_!=address(0) && outcomes_!=address(0) && settlement_!=address(0));
        module=module_; collateral=collateral_; outcomes=outcomes_; settlement=settlement_;
    }
    function isCurrentMarket(bytes32 id,uint64 generation,address pool,address module_,uint64 start,uint64 cutoff,uint64 expiry) external view returns(bool) {
        if(id==bytes32(0)||generation==0||module_!=module||pool.code.length==0
            ||start>cutoff||cutoff>=expiry||block.timestamp>=cutoff) return false;
        try this.validateNative(id,generation,pool,start,expiry) returns(bool valid) { return valid; }
        catch { return false; }
    }
    function validateNative(bytes32 id,uint64 generation,address pool,uint64 start,uint64 expiry) external view returns(bool) {
        IPCModuleState.Market memory m=IPCModuleState(module).markets(id);
        if(m.pool!=pool||m.collateral!=collateral||m.tradingStart!=start||m.expiry!=expiry
            ||IPCModuleState(module).marketNonce(id)!=generation) return false;
        IPCPoolState.Params memory p=IPCPoolState(pool).getBinaryPoolParams();
        return p.market==m.market && p.collateralToken==collateral && p.outcomeToken==outcomes
            && p.settlement==settlement && p.yesId==m.yesId && p.noId==m.noId && p.yesId!=p.noId
            && p.oneCollateral==1e6 && p.marketNonce==generation && !p.finalized
            && uint256(IPCPoolState(pool).marketExpiryNs())==uint256(expiry)*1e9
            && IPCMarket(m.market).status()==1;
    }
}
