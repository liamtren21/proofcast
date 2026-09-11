const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

function address(value) {
  if (typeof value !== 'string' || !ADDRESS.test(value.toLowerCase())) throw new Error('INVALID_ADDRESS');
  return value.toLowerCase();
}

function bytes32(value) {
  if (typeof value !== 'string' || !BYTES32.test(value.toLowerCase())) throw new Error('INVALID_BYTES32');
  return value.toLowerCase();
}

export function normalizeMarketRef(market) {
  return {
    ...market,
    chainId: 50312,
    module: address(market.module),
    marketAddress: address(market.marketAddress),
    pool: address(market.pool),
    collateral: address(market.collateral),
    outcomeToken: address(market.outcomeToken),
    venueId: bytes32(market.venueId),
    marketId: bytes32(market.marketId),
    generation: String(market.generation),
    yesId: String(market.yesId),
    noId: String(market.noId),
  };
}

export function validateSessionManifest({ chainId, markets, enrollUntilSec, sessionUntilSec }) {
  try {
    if (chainId !== 50312 || !Array.isArray(markets) || markets.length < 1 || markets.length > 3) throw new Error('INVALID_MANIFEST');
    if (!Number.isSafeInteger(enrollUntilSec) || !Number.isSafeInteger(sessionUntilSec) || enrollUntilSec >= sessionUntilSec) throw new Error('INVALID_PHASE');
    const normalized = markets.map(normalizeMarketRef);
    const ids = new Set();
    for (const market of normalized) {
      if (ids.has(market.marketId) || market.generation === '0' || market.tradingStartSec >= market.expirySec || market.decisionCutoffSec >= market.expirySec) throw new Error('INVALID_MARKET');
      ids.add(market.marketId);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.message };
  }
}
