import type { webcrypto } from "node:crypto";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  importPKCS8,
  type JWK,
} from "jose";

export type SigningKeys = {
  kid: string;
  alg: "ES256";
  privateKey: webcrypto.CryptoKey;
  publicKey: webcrypto.CryptoKey;
  publicJwk: JWK;
};

/** Loads the ES256 signing key from a PKCS8 PEM, or generates an ephemeral pair (dev and test). */
export async function loadSigningKeys(opts: { pem?: string; kid: string }): Promise<SigningKeys> {
  let privateKey: webcrypto.CryptoKey;
  let publicKey: webcrypto.CryptoKey;
  let kid: string;
  if (opts.pem) {
    privateKey = await importPKCS8(opts.pem, "ES256", { extractable: true });
    const jwk = await exportJWK(privateKey);
    delete jwk.d;
    publicKey = (await importJWK(jwk, "ES256")) as webcrypto.CryptoKey;
    kid = opts.kid;
  } else {
    ({ privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true }));
    // A restarted dev process must not publish a different key under an unchanged kid, because
    // remote JWKS caches only refetch on an unknown kid. Deriving the kid from the key itself
    // (rather than reusing opts.kid verbatim) guarantees a fresh ephemeral key gets a fresh kid.
    const thumbprint = await calculateJwkThumbprint(await exportJWK(publicKey));
    kid = `${opts.kid}-${thumbprint.slice(0, 8)}`;
  }
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: "ES256",
    use: "sig",
  };
  return { kid, alg: "ES256", privateKey, publicKey, publicJwk };
}

export function jwks(keys: SigningKeys): { keys: JWK[] } {
  return { keys: [keys.publicJwk] };
}
