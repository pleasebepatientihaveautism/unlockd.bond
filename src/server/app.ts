import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { PolicyError } from "../domain/policy.js";
import {
  advanceRequestSchema,
  confirmationSchema,
  liquidationPreviewRequestSchema,
  liquidationRequestSchema,
  positionRepaymentRequestSchema,
  repaymentRequestSchema
} from "../domain/schemas.js";
import type { AppConfig } from "./config.js";
import type { UnlockdBondService } from "./service.js";
import { StoreError } from "./store.js";

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  service: UnlockdBondService;
}

function errorCode(error: unknown): string {
  if (error instanceof PolicyError) return error.code;
  if (error instanceof StoreError) return error.message;
  if (error instanceof Error && /^[A-Z][A-Z0-9_:,-]{2,200}$/.test(error.message)) {
    return error.message;
  }
  return "REQUEST_FAILED";
}

function statusFor(code: string): number {
  if (code === "ADVANCE_NOT_FOUND" || code === "POSITION_NOT_FOUND") return 404;
  if (code.includes("HBAR") || code.includes("PAYER_BALANCE")) return 503;
  if (
    code.includes("TOKEN") ||
    code === "ORIGIN_NOT_ALLOWED" ||
    code === "SETTLEMENT_AUTH_REQUIRED"
  ) {
    return 403;
  }
  if (code.includes("FUNDING") || code.includes("PARTNER") || code.includes("ZEROG")) return 502;
  if (
    code.includes("EXPIRED") ||
    code.includes("NOT_FUNDABLE") ||
    code.includes("NOT_REPAYABLE") ||
    code.includes("ALREADY") ||
    code.includes("REPAYMENT_REVIEW") ||
    code.includes("LIQUIDATION_REVIEW")
  ) {
    return 409;
  }
  if (code.includes("REPAYMENT") || code.includes("LIQUIDATION") || code.includes("NOTE_BURN")) {
    return 502;
  }
  return 422;
}

function mutationOriginAllowed(config: AppConfig, origin: string): boolean {
  if (config.allowedOrigins.includes(origin)) return true;
  if (config.NODE_ENV === "production") return false;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function isSettlementMutation(request: Request): boolean {
  if (request.method !== "POST") return false;
  const requestPath = request.originalUrl.split("?")[0];
  return (
    /^\/api\/advances\/[^/]+\/(?:fund|repay)$/.test(requestPath) ||
    /^\/api\/positions\/[^/]+\/(?:repay|liquidate)$/.test(requestPath)
  );
}

function sessionCookie(request: Request): string | undefined {
  return request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("unlockd_session="))
    ?.slice("unlockd_session=".length);
}

function hasRouteSettlementCredential(request: Request): boolean {
  const requestPath = request.originalUrl.split("?")[0];
  if (/^\/api\/advances\/[^/]+\/(?:fund|repay)$/.test(requestPath)) {
    const confirmationToken =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>).confirmationToken
        : null;
    return (
      typeof confirmationToken === "string" &&
      confirmationToken.length >= 32 &&
      confirmationToken.length <= 300
    );
  }
  if (/^\/api\/positions\/[^/]+\/(?:repay|liquidate)$/.test(requestPath)) {
    const cookie = sessionCookie(request);
    return Boolean(cookie && /^[a-zA-Z0-9_-]{32,200}$/.test(cookie));
  }
  return false;
}

function settlementAuthorized(config: AppConfig, request: Request): boolean {
  if (config.mode === "demo") return true;
  const expected = config.SETTLEMENT_AUTH_SECRET;
  const authorization = request.header("authorization");
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (expected && presented) {
    const expectedDigest = createHash("sha256").update(expected).digest();
    const presentedDigest = createHash("sha256").update(presented).digest();
    if (timingSafeEqual(expectedDigest, presentedDigest)) return true;
  }
  return hasRouteSettlementCredential(request);
}

export function createApp(deps: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"]
        }
      },
      referrerPolicy: { policy: "no-referrer" }
    })
  );
  app.use(express.json({ limit: "32kb", strict: true }));
  app.use((request, response, next) => {
    const existingSessionCookie = sessionCookie(request);
    const sessionId =
      existingSessionCookie && /^[a-zA-Z0-9_-]{32,200}$/.test(existingSessionCookie)
        ? existingSessionCookie
        : randomBytes(32).toString("base64url");
    if (!existingSessionCookie) {
      const secure = deps.config.NODE_ENV === "production" ? "; Secure" : "";
      response.setHeader(
        "Set-Cookie",
        `unlockd_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`
      );
    }
    response.locals.ownerSessionHash = createHmac("sha256", deps.config.CONFIRMATION_SECRET)
      .update(`session:${sessionId}`)
      .digest("hex");
    next();
  });
  app.use((request, response, next) => {
    const started = performance.now();
    const requestId = request.header("x-request-id")?.slice(0, 100) ?? randomUUID();
    response.setHeader("x-request-id", requestId);
    response.on("finish", () => {
      deps.logger.info({
        requestId,
        method: request.method,
        route: request.route?.path ?? request.path,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started)
      });
    });
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: deps.config.mode === "demo" ? 120 : 30,
      standardHeaders: "draft-8",
      legacyHeaders: false
    })
  );
  app.use("/api", (request, _response, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();
    const origin = request.header("origin");
    if (origin && !mutationOriginAllowed(deps.config, origin)) {
      return next(new Error("ORIGIN_NOT_ALLOWED"));
    }
    return next();
  });
  app.use("/api", (request, _response, next) => {
    if (isSettlementMutation(request) && !settlementAuthorized(deps.config, request)) {
      return next(new Error("SETTLEMENT_AUTH_REQUIRED"));
    }
    return next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", mode: deps.config.mode, service: "unlockd-bond" });
  });

  let readinessCache: { at: number; checks: Record<string, boolean> } | null = null;
  app.get("/api/ready", async (_request, response) => {
    if (!readinessCache || Date.now() - readinessCache.at > 15_000) {
      readinessCache = { at: Date.now(), checks: await deps.service.readiness() };
    }
    const ready = Object.values(readinessCache.checks).every(Boolean);
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "degraded",
      mode: deps.config.mode,
      checks: readinessCache.checks
    });
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      mode: deps.config.mode,
      syntheticOnly: deps.config.mode !== "live",
      asset: "YAHOO_PRIVATE_COMPANIES",
      network: "Hedera Testnet",
      payoutAsset: {
        name: "USDC DEMO",
        symbol: "USDC",
        decimals: 6,
        tokenId: deps.config.HEDERA_STABLE_TOKEN_ID ?? null,
        label: "Demo USDC — no real value"
      },
      maxLtvBps: 7_000
    });
  });

  app.get("/api/market/private-companies", async (_request, response) => {
    const companies = await deps.service.privateCompanies();
    response.setHeader("cache-control", "public, max-age=60");
    response.json({ companies });
  });

  app.post("/api/advances/evaluate", async (request, response) => {
    const idempotencyKey = request.header("idempotency-key");
    const input = advanceRequestSchema.parse(request.body);
    if (!idempotencyKey || idempotencyKey !== input.requestId) {
      response.status(422).json({ error: "IDEMPOTENCY_KEY_MISMATCH" });
      return;
    }
    response.setHeader("cache-control", "no-store");
    response
      .status(201)
      .json(await deps.service.evaluate(input, String(response.locals.ownerSessionHash)));
  });

  app.post("/api/advances/:advanceId/fund", async (request, response) => {
    const input = confirmationSchema.parse(request.body);
    response.setHeader("cache-control", "no-store");
    response.json(
      await deps.service.fund(String(request.params.advanceId), input.confirmationToken)
    );
  });

  app.post("/api/advances/:advanceId/repay", async (request, response) => {
    const input = repaymentRequestSchema.parse(request.body);
    const idempotencyKey = request.header("idempotency-key");
    if (!idempotencyKey || idempotencyKey !== input.repaymentId) {
      response.status(422).json({ error: "IDEMPOTENCY_KEY_MISMATCH" });
      return;
    }
    response.setHeader("cache-control", "no-store");
    response.json(
      await deps.service.repay(
        String(request.params.advanceId),
        input.repaymentId,
        input.confirmationToken
      )
    );
  });

  app.get("/api/advances/:advanceId", async (request, response) => {
    const advance = await deps.service.get(String(request.params.advanceId));
    if (!advance) {
      response.status(404).json({ error: "ADVANCE_NOT_FOUND" });
      return;
    }
    response.setHeader("cache-control", "public, max-age=10");
    response.json({ advance });
  });

  app.get("/api/advances/:advanceId/payoff", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json({ payoff: await deps.service.payoff(String(request.params.advanceId)) });
  });

  app.get("/api/positions", async (request, response) => {
    const status = request.query.status === "closed" ? "closed" : "open";
    response.setHeader("cache-control", "no-store");
    response.json({
      positions: await deps.service.positions(String(response.locals.ownerSessionHash), status)
    });
  });

  app.get("/api/positions/:advanceId", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.json({
      position: await deps.service.position(
        String(request.params.advanceId),
        String(response.locals.ownerSessionHash)
      )
    });
  });

  app.get("/api/positions/:advanceId/valuations", async (request, response) => {
    const position = await deps.service.position(
      String(request.params.advanceId),
      String(response.locals.ownerSessionHash)
    );
    response.setHeader("cache-control", "no-store");
    response.json({ valuations: position.valuations });
  });

  app.post("/api/positions/:advanceId/repay", async (request, response) => {
    const input = positionRepaymentRequestSchema.parse(request.body);
    const idempotencyKey = request.header("idempotency-key");
    if (!idempotencyKey || idempotencyKey !== input.repaymentId) {
      response.status(422).json({ error: "IDEMPOTENCY_KEY_MISMATCH" });
      return;
    }
    response.setHeader("cache-control", "no-store");
    response.json(
      await deps.service.repayPosition(
        String(request.params.advanceId),
        input.repaymentId,
        input.amountMinor,
        String(response.locals.ownerSessionHash)
      )
    );
  });

  app.post("/api/positions/:advanceId/liquidation/preview", async (request, response) => {
    const input = liquidationPreviewRequestSchema.parse(request.body);
    response.setHeader("cache-control", "no-store");
    response.json({
      preview: await deps.service.liquidationPreview(
        String(request.params.advanceId),
        input.emulatedPriceMinor,
        String(response.locals.ownerSessionHash)
      )
    });
  });

  app.post("/api/positions/:advanceId/liquidate", async (request, response) => {
    const input = liquidationRequestSchema.parse(request.body);
    const idempotencyKey = request.header("idempotency-key");
    if (!idempotencyKey || idempotencyKey !== input.liquidationId) {
      response.status(422).json({ error: "IDEMPOTENCY_KEY_MISMATCH" });
      return;
    }
    response.setHeader("cache-control", "no-store");
    response.json(
      await deps.service.liquidatePosition(
        String(request.params.advanceId),
        input.liquidationId,
        input.emulatedPriceMinor,
        String(response.locals.ownerSessionHash)
      )
    );
  });

  if (deps.config.NODE_ENV === "production") {
    const clientPath = path.resolve("dist/client");
    app.use(
      "/assets",
      express.static(path.join(clientPath, "assets"), { immutable: true, maxAge: "1y" })
    );
    app.use(express.static(clientPath, { maxAge: 0 }));
    app.get("*splat", (_request, response) =>
      response.sendFile(path.join(clientPath, "index.html"))
    );
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(422).json({
        error: "VALIDATION_FAILED",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }
    const code = errorCode(error);
    deps.logger.warn({ code }, "request failed");
    response.status(statusFor(code)).json({
      error: code,
      message: code === "REQUEST_FAILED" ? "The request could not be completed." : undefined
    });
  });
  return app;
}
