import { keccak256, toUtf8Bytes } from 'ethers';

const ROOT_FIELDS = new Set(['version', 'title', 'strategy', 'terms', 'evidence']);
const TERM_FIELDS = new Set(['maxCost', 'side']);

function sortValue(value, path = 'root') {
  if (Array.isArray(value)) return value.map((entry, index) => sortValue(entry, `${path}.${index}`));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString(10);
    return value;
  }
  const allowed = path === 'root' ? ROOT_FIELDS : path === 'root.terms' ? TERM_FIELDS : null;
  if (allowed) for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`UNKNOWN_FIELD:${path}.${key}`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key], `${path}.${key}`)]));
}

export function canonicalizeContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('INVALID_CONTENT');
  return JSON.stringify(sortValue(content));
}

export async function hashContent(content) {
  return keccak256(toUtf8Bytes(canonicalizeContent(content)));
}
