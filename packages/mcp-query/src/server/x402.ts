// x402 wire format — the HTTP 402 machine-native payments challenge body. Pure
// parsing, no protocol/transport dependency (mcp-query and a2a-query each
// have their own detection seam for the 402, but share this shape).

export interface X402PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface X402Challenge {
  x402Version: number;
  accepts: X402PaymentRequirement[];
  error?: string;
}

function isPaymentRequirement(v: unknown): v is X402PaymentRequirement {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.scheme === "string" && typeof r.network === "string" && typeof r.maxAmountRequired === "string" && typeof r.payTo === "string" && typeof r.asset === "string";
}

/** Parse a 402 response body as an x402 challenge. Returns undefined on any shape mismatch — never throws. */
export function parseX402Challenge(body?: string): X402Challenge | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const p = parsed as Record<string, unknown>;
  if (typeof p.x402Version !== "number" || !Array.isArray(p.accepts) || !p.accepts.every(isPaymentRequirement)) return undefined;
  return { x402Version: p.x402Version, accepts: p.accepts as X402PaymentRequirement[], ...(typeof p.error === "string" ? { error: p.error } : {}) };
}
