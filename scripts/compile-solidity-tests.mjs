import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = path.resolve('contracts');
const files = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.sol')) files.push(full);
  }
}
collect(root);
const sources = Object.fromEntries(files.map((file) => [path.relative(root, file).replaceAll('\\', '/'), { content: fs.readFileSync(file, 'utf8') }]));
const output = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources,
  settings: { outputSelection: { '*': { '*': ['abi'] } } },
})));
const errors = output.errors?.filter((error) => error.severity === 'error') ?? [];
if (errors.length) {
  console.error(output.errors);
  process.exit(1);
}
const tests = files.filter((file) => file.endsWith('.t.sol')).length;
console.log(`compiled ${tests} Solidity test sources`);
