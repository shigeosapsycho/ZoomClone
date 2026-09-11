import { SignJWT, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearer, createTestContext, mintUser, type TestContext } from "../../test/helpers";
import { orgIdFromClaim } from "./user-id";
import { OidcUserVerifier } from "./user-verifier";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe("auth", () => {
  it("publishes the signaling verification key", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ keys: Array<Record<string, unknown>> }>();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ alg: "ES256", kty: "EC" });
    expect(String(body.keys[0]?.kid)).toMatch(new RegExp(`^${ctx.env.SIGNING_KID}-`));
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("mints dev tokens that identify the user on /v1/me", async () => {
    const { token, sub, orgId } = await mintUser(ctx, { name: "Ana" });
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: sub, org_id: orgId, name: "Ana" });
  });

  it("falls back to the default org and name", async () => {
    const { token } = await mintUser(ctx, {});
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(res.json()).toMatchObject({ org_id: ctx.env.DEFAULT_ORG_ID, name: "Dev User" });
  });

  it("requires a bearer on /v1/me and rejects bad bearers everywhere", async () => {
    const missing = await ctx.app.inject({ method: "GET", url: "/v1/me" });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "bearer token required" },
    });
    const garbage = await ctx.app.inject({
      method: "GET",
      url: "/healthz",
      headers: bearer("not.a.jwt"),
    });
    expect(garbage.statusCode).toBe(401);
    expect(garbage.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects tokens signed by another key", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: ctx.env.SIGNING_KID })
      .setIssuer(ctx.env.DEV_ISSUER_URL)
      .setAudience(ctx.env.OIDC_AUDIENCE)
      .setSubject("2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(forged) });
    expect(res.statusCode).toBe(401);
  });

  it("maps a non-UUID org_id claim through orgIdFromClaim, scoped by issuer", async () => {
    const token = await new SignJWT({ org_id: "org_abc" })
      .setProtectedHeader({ alg: "ES256", kid: ctx.deps.keys.kid })
      .setIssuer(ctx.env.DEV_ISSUER_URL)
      .setAudience(ctx.env.OIDC_AUDIENCE)
      .setSubject("2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(ctx.deps.keys.privateKey);
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      org_id: orgIdFromClaim(ctx.env.DEV_ISSUER_URL, "org_abc"),
    });
  });

  it("rejects tokens whose algorithm is not allowed", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ctx.env.DEV_ISSUER_URL)
      .setAudience(ctx.env.OIDC_AUDIENCE)
      .setSubject("2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const res = await ctx.app.inject({ method: "GET", url: "/v1/me", headers: bearer(forged) });
    expect(res.statusCode).toBe(401);
  });

  it("OidcUserVerifier with requireOrg rejects tokens with no org_id and accepts a UUID org", async () => {
    const verifier = new OidcUserVerifier({
      key: ctx.deps.keys.publicKey,
      issuer: ctx.env.DEV_ISSUER_URL,
      audience: ctx.env.OIDC_AUDIENCE,
      algorithms: ["ES256"],
      defaultOrgId: ctx.env.DEFAULT_ORG_ID,
      requireOrg: true,
    });
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: ctx.deps.keys.kid })
        .setIssuer(ctx.env.DEV_ISSUER_URL)
        .setAudience(ctx.env.OIDC_AUDIENCE)
        .setSubject("2f6a2b6e-6f0b-4c1e-9a52-0c5d3f1a9b12")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(ctx.deps.keys.privateKey);

    const withoutOrg = await sign({});
    await expect(verifier.verify(withoutOrg)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });

    const orgId = "22222222-2222-4222-8222-222222222222";
    const withOrg = await sign({ org_id: orgId });
    await expect(verifier.verify(withOrg)).resolves.toMatchObject({ orgId });
  });

  it("does not serve the dev issuer when it is disabled", async () => {
    const prod = await createTestContext({
      AUTH_DEV_ISSUER: "false",
      OIDC_ISSUER: "https://idp.example.com",
      OIDC_JWKS_URL: "https://idp.example.com/jwks",
    });
    try {
      const res = await prod.app.inject({ method: "POST", url: "/dev/oidc/token", payload: {} });
      expect(res.statusCode).toBe(404);
    } finally {
      await prod.close();
    }
  });
});
