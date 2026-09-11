import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = path.resolve('contracts');
const files = [path.join(root, 'ProofCast.sol')];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.sol')) files.push(full);
  }
}

collect(path.join(root, 'src'));
const sources = Object.fromEntries(files.map((file) => [path.relative(root, file).replaceAll('\\', '/'), { content: fs.readFileSync(file, 'utf8') }]));
const input = {
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'cancun',
    viaIR: false,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors?.filter((error) => error.severity === 'error') ?? [];
if (errors.length) {
  console.error(output.errors);
  process.exit(1);
}

fs.mkdirSync('artifacts', { recursive: true });
for (const [sourceName, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    if (!artifact.evm?.bytecode?.object) continue;
    fs.writeFileSync(path.join('artifacts', `${contractName}.json`), JSON.stringify({ ...artifact, sourceName, contractName }, null, 2));
  }
}
console.log(`compiled ${Object.values(output.contracts ?? {}).reduce((count, contracts) => count + Object.keys(contracts).length, 0)} Solidity contracts`);
