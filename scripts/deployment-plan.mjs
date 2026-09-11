const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function requiredAddress(value, name) { if (!ADDRESS.test(value ?? '')) throw new Error(`${name}_REQUIRED`); return value; }

export function buildDeploymentPlan(input = {}) {
  const catalog = requiredAddress(input.catalog, 'CATALOG');
  return {
    chainId: 50312,
    nativeExecutionEnabled: false,
    steps: [
      { name: 'ProofCastDreamDexAdapter', constructorArgs: [] },
      { name: 'ProofCastRegistry', constructorArgs: ['<catalog-address>'] },
      { name: 'ProofCastExecutor', constructorArgs: ['<registry-address>', '<adapter-address>'] },
      { name: 'ProofCastFactory', constructorArgs: ['<registry-address>', '<executor-address>', '<adapter-address>'] },
      { name: 'link-factory', action: 'adapter.setFactory(factory); executor.setFactory(factory)' },
    ],
    resolved: { catalog },
    gates: { nativeVerified: false, fundingEnabled: false, sponsorEnabled: false },
  };
}
