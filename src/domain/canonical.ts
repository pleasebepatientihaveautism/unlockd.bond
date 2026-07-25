import { createHash, createHmac, randomBytes } from "node:crypto";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: unknown): string {
  const source = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(source).digest("hex");
}

export function saltedCommitment(
  value: unknown,
  secret: string
): { commitment: string; nonce: string } {
  const nonce = randomBytes(32).toString("hex");
  const digest = createHash("sha256")
    .update(canonicalJson(value))
    .update(":")
    .update(secret)
    .update(":")
    .update(nonce)
    .digest("hex");
  return { commitment: `sha256:${digest}`, nonce };
}

export function confirmationDigest(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}
