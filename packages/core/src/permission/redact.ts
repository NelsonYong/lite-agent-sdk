export type Redactor = (input: unknown) => unknown;

// Best-effort masking of common secrets/PII in string values. Matches substrings so a
// token embedded in a larger command is still masked. Documented as best-effort.
const SECRET = /(bearer\s+[\w.\-]+|sk-[A-Za-z0-9]{16,}|eyJ[\w.\-]{20,}|[\w.+-]+@[\w-]+\.[\w.-]+|(?:api[_-]?key|token|secret|password)["'\s:=]+[\w.\-]{6,})/gi;

const maskString = (s: string): string => s.replace(SECRET, "[redacted]");

export const defaultRedactor: Redactor = (input) => {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return maskString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(input);
};
