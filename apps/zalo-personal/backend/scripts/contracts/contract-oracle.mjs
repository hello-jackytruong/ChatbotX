import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const oldArg = valueAfter('--old');
const newArg = valueAfter('--new');
if (!oldArg || !newArg) {
  console.error('Usage: npm run test:oracle -- --old <repo-or-backend> --new <repo-or-backend>');
  process.exit(2);
}

function contractRoot(input) {
  const root = path.resolve(input);
  const direct = path.join(root, 'contracts/baseline');
  const nested = path.join(root, 'backend/contracts/baseline');
  if (fs.existsSync(direct)) return direct;
  if (fs.existsSync(nested)) return nested;
  throw new Error(`No contracts/baseline directory under ${root}`);
}

const oldRoot = contractRoot(oldArg);
const newRoot = contractRoot(newArg);
const names = [
  'database-contract.json',
  'rest-contract.json',
  'runtime-rest-contract.json',
  'socket-contract.json',
  'runtime-socket-contract.json',
  'object-contract.json',
  'function-test-map.json',
  'scenario-catalog.json',
];
let failed = false;
for (const name of names) {
  const oldContent = fs.readFileSync(path.join(oldRoot, name), 'utf8');
  const newContent = fs.readFileSync(path.join(newRoot, name), 'utf8');
  const oldHash = crypto.createHash('sha256').update(oldContent).digest('hex');
  const newHash = crypto.createHash('sha256').update(newContent).digest('hex');
  if (oldContent !== newContent) {
    console.error(`DIFF ${name}: ${oldHash} != ${newHash}`);
    failed = true;
  } else {
    console.log(`MATCH ${name}: ${oldHash}`);
  }
}
if (failed) process.exitCode = 1;
else console.log('Contract oracle: zero diff.');
