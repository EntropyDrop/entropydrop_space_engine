export const MAX_INVENTORY_NAME_LENGTH = 80;

// Match Python str.strip() and count Unicode code points on both sides.
const LEADING_WHITESPACE = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const TRAILING_WHITESPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;

export function trimInventoryName(value: string): string {
  return value.replace(LEADING_WHITESPACE, '').replace(TRAILING_WHITESPACE, '');
}

export function inventoryNameLength(value: string): number {
  return Array.from(value).length;
}

export function truncateInventoryName(value: string): string {
  return Array.from(value).slice(0, MAX_INVENTORY_NAME_LENGTH).join('');
}

export function normalizeInventoryName(value: unknown): string {
  return typeof value === 'string' ? truncateInventoryName(trimInventoryName(value)) : '';
}
