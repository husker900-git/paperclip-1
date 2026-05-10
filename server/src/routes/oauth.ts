import { Router, type Request, type Response } from "express";
import type { ProviderRegistry } from "../oauth/registry.js";
import type { RegisteredProvider } from "../oauth/types.js";
import type { SlidingWindowLimiter } from "../oauth/rate-limiter.js";
import { generateCodeVerifier, deriveCodeChallenge } from "../oauth/pkce.js";
import { validateReturnUrl } from "../oauth/redirect-allowlist.js";
import { oauthAuthorizationStates } from "@paperclipai/db/schema/oauth";

export interface OAuthRouteDeps {
  registry: ProviderRegistry;
  // db: Drizzle handle (typed via @paperclipai/db); kept loose here so the
  // router factory does not require pulling the full Db type into route code.
  db: any;
  publicUrl: string;
  rateLimiter: SlidingWindowLimiter;
  // additional deps wired in later tasks: secretService
}

const STATE_TTL_MS = 10 * 60 * 1000;

function summary(p: RegisteredProvider) {
  return {
    id: p.config.id,
    displayName: p.config.displayName,
    iconUrl: p.config.iconUrl,
    docUrl: p.config.docUrl,
    scopesOffered: p.config.scopes.offered,
    scopesDefault: p.config.scopes.default,
  };
}

function ensureMember(req: Request, res: Response): boolean {
  const actor = (req as Request & { actor?: { type: string; memberships?: Array<{ companyId: string }> } }).actor;
  const companyId = req.params.companyId;
  if (!actor || actor.type === "none") {
    res.status(401).json({ errorCode: "unauthenticated" });
    return false;
  }
  const ok = (actor.memberships ?? []).some((m) => m.companyId === companyId);
  if (!ok) {
    // 404 not 403, per spec 9.8
    res.status(404).end();
    return false;
  }
  return true;
}

export function oauthRoutes(deps: OAuthRouteDeps): Router {
  const r = Router({ mergeParams: true });

  r.get("/providers", (req, res) => {
    if (!ensureMember(req, res)) return;
    res.json({ providers: deps.registry.list().map(summary) });
  });

  r.get("/providers/:providerId", (req, res) => {
    if (!ensureMember(req, res)) return;
    const p = deps.registry.get(req.params.providerId);
    if (!p) {
      res.status(404).json({ errorCode: "provider_not_found" });
      return;
    }
    res.json(summary(p));
  });

  r.post("/connect/:providerId", async (req, res) => {
    if (!ensureMember(req, res)) return;
    const provider = deps.registry.get(req.params.providerId);
    if (!provider) {
      res.status(404).json({ errorCode: "provider_not_found" });
      return;
    }

    const actor = (req as Request & { actor: { userId: string } }).actor;
    const ok = await deps.rateLimiter.check(`connect:${actor.userId}`);
    if (!ok) {
      res.status(429).json({ errorCode: "rate_limited" });
      return;
    }

    const { scopes, returnUrl } = (req.body ?? {}) as {
      scopes?: unknown;
      returnUrl?: unknown;
    };
    const requestedScopes =
      Array.isArray(scopes) && scopes.every((s) => typeof s === "string")
        ? (scopes as string[])
        : provider.config.scopes.default;
    const offered = new Set(provider.config.scopes.offered);
    if (!requestedScopes.every((s) => offered.has(s))) {
      res.status(400).json({ errorCode: "invalid_scope" });
      return;
    }

    const verifier = generateCodeVerifier();
    const challenge = deriveCodeChallenge(verifier);
    const redirectUri = `${deps.publicUrl}/api/oauth/callback/${provider.config.id}`;
    const safeReturnUrl =
      typeof returnUrl === "string"
        ? validateReturnUrl(returnUrl, deps.publicUrl)
        : "/settings/connections";
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    const [row] = await deps.db
      .insert(oauthAuthorizationStates)
      .values({
        companyId: req.params.companyId,
        providerId: provider.config.id,
        codeVerifier: verifier,
        redirectUri,
        scopesRequested: requestedScopes,
        initiatedByUserId: actor.userId,
        returnUrl: safeReturnUrl,
        expiresAt,
      })
      .returning();

    const authorizeUrl = new URL(provider.config.endpoints.authorize);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", provider.clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", requestedScopes.join(" "));
    authorizeUrl.searchParams.set("state", row.id);
    if (provider.config.pkce !== "unsupported") {
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
    }

    res.json({ authorizeUrl: authorizeUrl.toString(), state: row.id });
  });

  return r;
}
