// Opt-in DPoP (RFC 9449) support for FileOAuthProvider. The SDK gained DPoP in
// @modelcontextprotocol/client 2.1.0 (`OAuthClientProvider.dpop()`, `DpopSession`,
// `generateDpopKeyPair`); on 2.0.0 these do not exist, so everything here feature-detects
// and `--dpop` fails with a clear message instead of silently sending unbound tokens.
//
// The signing key is persisted so a refresh token stays bound to the same key across
// processes. It is written with file mode 0600 (directory 0700) and is never logged:
// callers only ever see the RFC 7638 thumbprint.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as sdk from "@modelcontextprotocol/client";
import type { webcrypto } from "node:crypto";

type Jwk = webcrypto.JsonWebKey;

export const DPOP_MIN_SDK = "2.1.0";

/** The slice of the SDK's `DpopSession` this package relies on. */
export interface DpopSessionLike {
  readonly thumbprint: string;
  readonly alg: string;
}

interface SdkDpop {
  DpopSession?: { create(o?: { alg?: string; keyPair?: unknown }): Promise<DpopSessionLike> };
  generateDpopKeyPair?: (o?: { alg?: string; extractable?: boolean }) => Promise<{
    privateKey: CryptoKey;
    publicKey: CryptoKey;
    publicJwk: Jwk;
    thumbprint: string;
    alg: string;
  }>;
}

/** True when the installed SDK ships DPoP (>= 2.1.0). */
export function dpopSupported(sdkExports: SdkDpop = sdk as unknown as SdkDpop): boolean {
  return typeof sdkExports.DpopSession?.create === "function" && typeof sdkExports.generateDpopKeyPair === "function";
}

export function assertDpopSupported(sdkExports: SdkDpop = sdk as unknown as SdkDpop): void {
  if (!dpopSupported(sdkExports)) {
    throw new Error(
      `--dpop needs @modelcontextprotocol/client >= ${DPOP_MIN_SDK} (the installed version has no DPoP support). ` +
        `Upgrade the SDK, or drop --dpop to use plain bearer tokens.`,
    );
  }
}

interface StoredKey {
  v: 1;
  alg: "ES256";
  thumbprint: string;
  publicJwk: Jwk;
  privateJwk: Jwk;
}

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

function writeSecret(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600); // `mode` only applies on creation; tighten a pre-existing file too
}

/** Where a cache file's DPoP key lives. */
export function dpopKeyPath(cacheFile: string): string {
  return cacheFile.replace(/\.json$/, "") + ".dpop-key.json";
}

/** Load the persisted key (or generate + persist one) and wrap it in an SDK `DpopSession`. */
export async function loadOrCreateDpopSession(keyFile: string, sdkExports: SdkDpop = sdk as unknown as SdkDpop): Promise<DpopSessionLike> {
  assertDpopSupported(sdkExports);
  const { DpopSession, generateDpopKeyPair } = sdkExports as Required<SdkDpop>;
  if (existsSync(keyFile)) {
    try {
      const k = JSON.parse(readFileSync(keyFile, "utf8")) as StoredKey;
      if (k.v === 1 && k.alg === "ES256" && k.privateJwk && k.publicJwk && k.thumbprint) {
        const privateKey = await crypto.subtle.importKey("jwk", k.privateJwk, ES256, false, ["sign"]);
        const publicKey = await crypto.subtle.importKey("jwk", k.publicJwk, ES256, true, ["verify"]);
        return DpopSession.create({ keyPair: { privateKey, publicKey, publicJwk: k.publicJwk, thumbprint: k.thumbprint, alg: "ES256" } });
      }
    } catch {
      /* unreadable key file: fall through and mint a new one */
    }
  }
  const kp = await generateDpopKeyPair({ alg: "ES256", extractable: true });
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const stored: StoredKey = { v: 1, alg: "ES256", thumbprint: kp.thumbprint, publicJwk: kp.publicJwk, privateJwk };
  writeSecret(keyFile, JSON.stringify(stored));
  return DpopSession.create({ keyPair: kp });
}
