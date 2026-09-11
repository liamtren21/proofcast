import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile(new URL('../config/shannon.json', import.meta.url), 'utf8'));
const result = {
  chainId: config.chainId,
  historicalDeployment: config.legacy,
  proofcastDeployment: config.proofcast,
  nativeVerified: false,
  fundingEnabled: false,
  reason: 'No current read-only RPC evidence supplied; historical addresses are not proof of the new contracts.'
};
console.log(JSON.stringify(result, null, 2));
if (result.nativeVerified || result.fundingEnabled) process.exitCode = 1;
