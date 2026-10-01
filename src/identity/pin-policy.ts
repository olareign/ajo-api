/** A transaction PIN is six digits and not one anyone would try first. */
export function isAcceptablePin(pin: string): boolean {
  if (!/^\d{6}$/.test(pin)) return false;
  const digits = pin.split("").map(Number);
  if (digits.every((d) => d === digits[0])) return false;
  const steps = digits.slice(1).map((d, i) => d - digits[i]!);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return false;
  if (pin.slice(0, 3) === pin.slice(3)) return false;
  return true;
}
