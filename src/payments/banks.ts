/**
 * The Nigerian banks the app offers (NIBSS codes). With a payment partner connected the partner is the
 * authority on who can receive money; this list gives a name to the code a person picked, for showing
 * "GTBank •••• 6789" and nothing more.
 */
export const NG_BANKS: Readonly<Record<string, string>> = {
  "044": "Access Bank",
  "058": "GTBank",
  "011": "First Bank",
  "033": "UBA",
  "057": "Zenith Bank",
  "070": "Fidelity Bank",
  "221": "Stanbic IBTC",
  "232": "Sterling Bank",
  "035": "Wema Bank",
  "032": "Union Bank",
  "076": "Polaris Bank",
  "50211": "Kuda",
  "50515": "Moniepoint",
  "999991": "PalmPay",
  "999992": "OPay",
};

export const bankName = (code: string): string => NG_BANKS[code] ?? "Your bank";
