/** International form: a plus, a country code, and 8 to 15 digits in all. */
export const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Turns what someone typed into the international form, reading a local number by the account's
 * country: "0803 123 4567" in Nigeria is +2348031234567, "07700 900123" in the UK is +447700900123.
 * Spaces, dashes, dots and brackets are ignored; "00" works as "+". Null when it can't be a number.
 */
export function normalizePhone(raw: string, country: string | null): string | null {
  let text = raw.trim().replace(/[\s\-.()]/g, "");
  if (text.startsWith("00")) text = `+${text.slice(2)}`;
  if (!text.startsWith("+")) {
    if (country === "NG" && /^0[789][01]\d{8}$/.test(text)) text = `+234${text.slice(1)}`;
    else if (country === "GB" && /^07\d{9}$/.test(text)) text = `+44${text.slice(1)}`;
    else return null;
  }
  return E164.test(text) ? text : null;
}
