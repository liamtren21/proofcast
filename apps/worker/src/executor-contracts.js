import { ethers } from 'ethers';

// Worker-owned ABI surface. No write functions for enrollment, owners, native
// markets, approvals, arbitrary calls, or deployment are exposed here.
export const EXECUTOR_ABI = [
  'function execute(bytes32 enrollmentId,bytes32 marketId) returns((uint8 status,uint256 actualCost,uint256 filledAmount,uint128 nativeOrderId))',
  'function recover(bytes32 enrollmentId,bytes32 marketId) returns((uint8 status,uint256 cashDelta,uint256 recoveredPosition))',
  'function registry() view returns(address)', 'function factory() view returns(address)', 'function adapter() view returns(address)',
  'function enrollments(bytes32) view returns(bytes32 sessionId,address follower,address vault,bool active)',
  'function consumedSignals(bytes32,bytes32) view returns(bool)',
  'event Enrolled(bytes32 indexed enrollmentId,bytes32 indexed sessionId,address indexed follower,address vault,uint256 nonce)'
];
export const REGISTRY_ABI = [
  'function isRegistered(bytes32) view returns(bool)', 'function isWithdrawn(bytes32) view returns(bool)',
  'function marketCount(bytes32) view returns(uint256)',
  'function marketRef(bytes32,uint256) view returns((bytes32 marketId,uint64 generation,address pool,address module,address collateral,address outcomeToken,uint256 yesId,uint256 noId,uint32 operatorId,bytes32 venueId,uint64 tradingStart,uint64 decisionCutoff,uint64 expiry))',
  'function signal(bytes32,bytes32) view returns((bytes32 signalId,uint8 side,uint256 price,uint64 validUntil,bytes32 evidenceHash,uint256 nonce,uint64 anchoredAt))'
];
export const FACTORY_ABI = ['function vaultFor(bytes32) view returns(address)','function registry() view returns(address)','function executor() view returns(address)','function adapter() view returns(address)'];
export const VAULT_ABI = ['function recoveryConfigs(bytes32) view returns(address resolutionModule,uint32 operatorId,bytes32 venueId,uint64 generation,uint8 outcomeIndex,uint256 positionAmount,uint256 costBasis,bool resolved)'];
export const executorInterface = new ethers.Interface(EXECUTOR_ABI);
const same = (a,b) => a.toLowerCase() === b.toLowerCase();
export function typedRequest(config, job) {
  if (!['execute','recover'].includes(job.action) || !ethers.isHexString(job.enrollmentId,32) || !ethers.isHexString(job.marketId,32)) throw new Error('INVALID_EXECUTOR_JOB');
  return {to:config.executor, data:executorInterface.encodeFunctionData(job.action,[job.enrollmentId,job.marketId]),value:0n};
}

export function createExecutorGateway(provider, config) {
  const executor=new ethers.Contract(config.executor,EXECUTOR_ABI,provider);
  const registry=new ethers.Contract(config.registry,REGISTRY_ABI,provider);
  const factory=new ethers.Contract(config.factory,FACTORY_ABI,provider);
  return {
    provider,
    async verifyDeployment(blockTag) {
      for(const name of ['executor','registry','factory','adapter']) {
        const code=await provider.getCode(config[name],blockTag);
        if(code==='0x' || (config.codeHashes?.[name] && ethers.keccak256(code)!==config.codeHashes[name])) throw new Error('EXECUTOR_DEPLOYMENT_MISMATCH');
      }
      for(const [contract,fields] of [[executor,['registry','factory','adapter']],[factory,['registry','executor','adapter']]]) {
        for(const field of fields) if(!same(await contract[field]({blockTag}),config[field])) throw new Error('EXECUTOR_DEPLOYMENT_MISMATCH');
      }
    },
    async enrollment(id,blockTag) {
      const e=await executor.enrollments(id,{blockTag});
      if(e.vault===ethers.ZeroAddress || !same(await factory.vaultFor(id,{blockTag}),e.vault)) return null;
      return e;
    },
    registered:(id,blockTag)=>registry.isRegistered(id,{blockTag}),
    withdrawn:(id,blockTag)=>registry.isWithdrawn(id,{blockTag}),
    async markets(id,blockTag) {
      const count=Number(await registry.marketCount(id,{blockTag}));
      if(count<1 || count>3) throw new Error('INVALID_REGISTRY_MARKETS');
      return Promise.all(Array.from({length:count},async(_,i)=>(await registry.marketRef(id,i,{blockTag})).marketId));
    },
    signal:(session,market,blockTag)=>registry.signal(session,market,{blockTag}),
    consumed:(enrollment,market,blockTag)=>executor.consumedSignals(enrollment,market,{blockTag}),
    recovery:(vault,market,blockTag)=>new ethers.Contract(vault,VAULT_ABI,provider).recoveryConfigs(market,{blockTag}),
    async simulate(job,from) {
      const request=typedRequest(config,job);
      const result=await provider.call({...request,from,blockTag:'latest'});
      return executorInterface.decodeFunctionResult(job.action,result)[0].status;
    },
    estimate:(job,from)=>provider.estimateGas({...typedRequest(config,job),from})
  };
}
