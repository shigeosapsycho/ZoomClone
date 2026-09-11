import type { webcrypto } from "node:crypto";
import { exportJWK, generateKeyPair, importJWK, importPKCS8, type JWK } from "jose";

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
  if (opts.pem) {
    privateKey = await importPKCS8(opts.pem, "ES256", { extractable: true });
    const jwk = await exportJWK(privateKey);
    delete jwk.d;
    publicKey = (await importJWK(jwk, "ES256")) as webcrypto.CryptoKey;
  } else {
    ({ privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true }));
  }
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid: opts.kid,
    alg: "ES256",
    use: "sig",
  };
  return { kid: opts.kid, alg: "ES256", privateKey, publicKey, publicJwk };
}

export function jwks(keys: SigningKeys): { keys: JWK[] } {
  return { keys: [keys.publicJwk] };
}
