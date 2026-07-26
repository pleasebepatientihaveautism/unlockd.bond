import { randomUUID } from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { PolicyError } from "../domain/policy.js";
import { advanceRequestSchema, confirmationSchema } from "../domain/schemas.js";
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
  if (code === "ADVANCE_NOT_FOUND") return 404;
  if (code.includes("TOKEN") || code === "ORIGIN_NOT_ALLOWED") return 403;
  if (code.includes("FUNDING") || code.includes("PARTNER") || code.includes("ZEROG")) return 502;
  if (code.includes("EXPIRED") || code.includes("NOT_FUNDABLE")) return 409;
  return 422;
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
    if (origin && !deps.config.allowedOrigins.includes(origin)) {
      return next(new Error("ORIGIN_NOT_ALLOWED"));
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
    response.status(201).json(await deps.service.evaluate(input));
  });

  app.post("/api/advances/:advanceId/fund", async (request, response) => {
    const input = confirmationSchema.parse(request.body);
    response.setHeader("cache-control", "no-store");
    response.json(
      await deps.service.fund(String(request.params.advanceId), input.confirmationToken)
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
