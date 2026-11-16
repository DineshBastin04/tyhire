/**
 * HR types salaries in lakhs per annum; everything behind the form stores plain rupees.
 *
 * The split is deliberate and the conversion belongs only at the edges. The stored band is
 * compared directly against a candidate's `expected_salary` (services/knockout.py), which
 * is an annual rupee figure, so both sides of that comparison have to be in the same unit
 * or the rule silently does the wrong thing — a band stored as "10" would knock out every
 * candidate expecting more than ten rupees, which is all of them, and nothing in the UI
 * would say why.
 *
 * Rupees also stay the stored unit because jobs created before this existed already hold
 * rupee figures, and reinterpreting those as lakhs would move every band by a factor of
 * 100,000 without anyone touching them.
 */

export const RUPEES_PER_LAKH = 100_000;

/**
 * "5.5" -> 550000. Blank or unparseable input returns null, which the API reads as "no
 * band set" rather than as zero — zero is a real constraint (a maximum budget of nothing)
 * and must not be what a typo produces.
 */
export function lpaToRupees(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lpa = Number(trimmed);
  if (!Number.isFinite(lpa) || lpa < 0) return null;
  // Rounded because the column is an integer. 5.5 LPA is exactly 550000, and anything
  // carried to more decimal places than a rupee can express is settled here rather than
  // arriving at the API as a float it would reject.
  return Math.round(lpa * RUPEES_PER_LAKH);
}

/**
 * 550000 -> "5.5", 500000 -> "5". Trailing zeros are dropped so reopening an untouched
 * job shows the figure the way it was typed, not "5.00".
 */
export function rupeesToLpaInput(rupees: number | null | undefined): string {
  if (rupees == null || !Number.isFinite(rupees)) return "";
  // toFixed(4) is a rupee-level rounding guard against binary floating point turning
  // 550000 / 100000 into 5.500000000000001; Number() then strips the trailing zeros.
  return String(Number((rupees / RUPEES_PER_LAKH).toFixed(4)));
}
