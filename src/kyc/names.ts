const tokens = (name: string): string[] =>
  name
    .toUpperCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Whether a bank account's name is the person's own. Order and capitals do not matter, and a bank may
 * hold more or fewer of the names; but at least two names must agree (or the only one there is), so a
 * shared first name alone is not a match. The same rule as the web app's, which previews it.
 */
export function namesMatch(accountName: string, idName: string): boolean {
  const a = new Set(tokens(accountName));
  const b = new Set(tokens(idName));
  const needed = Math.min(2, a.size, b.size);
  if (needed === 0) return false;
  return [...a].filter((token) => b.has(token)).length >= needed;
}
