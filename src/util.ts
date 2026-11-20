/** Parse a Looker UTC timestamp ("2026-11-18 10:00:05" or ISO). NaN when invalid. */
export function parseUtc(v: unknown): number {
  if (typeof v !== "string") return NaN;
  const s = v.trim().replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
}
export const fmtLooker = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
export const toNumber = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
export const cleanValue = (v: unknown, max = 100): string => {
  const s = v == null ? "" : String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return s || "unknown";
};
