import fs from 'node:fs/promises';
import { buildDeploymentPlan } from './deployment-plan.mjs';

const plan = buildDeploymentPlan({ catalog: process.env.DREAMDEX_CATALOG });
await fs.writeFile(new URL('../docs/evidence/deployment-plan.json', import.meta.url), JSON.stringify(plan, null, 2));
console.log(JSON.stringify(plan, null, 2));
console.log('No transaction sent: native execution and funding remain fail-closed.');
