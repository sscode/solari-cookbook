import path from "node:path"

import express, { type Express, type NextFunction, type Request, type Response } from "express"
import helmet from "helmet"
import pinoHttp from "pino-http"
import { ZodError } from "zod"

import type { ApiError, PublicAppConfig } from "../shared/model"
import { RunRequestSchema } from "../shared/schema"
import type { AppEnvironment } from "./config"
import { CoordinatorError, RunCoordinator } from "./coordinator"
import { RunStore } from "./store"

interface CreateAppOptions {
  environment: AppEnvironment
  store: RunStore
  coordinator: RunCoordinator
}

export function createApp(options: CreateAppOptions): Express {
  const { environment, store, coordinator } = options
  const app = express()

  app.disable("x-powered-by")
  app.set("trust proxy", 1)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
  )
  app.use(pinoHttp({ quietReqLogger: environment.nodeEnv === "test" }))
  app.use(express.json({ limit: "16kb", strict: true }))

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, service: "pr-flight-deck" })
  })

  app.get("/api/config", (_request, response) => {
    const config: PublicAppConfig = {
      liveAvailable: coordinator.liveAvailable,
      publicDemo: environment.publicDemo,
      demoTarget:
        environment.demoRepository && environment.demoPullNumber
          ? {
              repository: environment.demoRepository,
              pullNumber: environment.demoPullNumber,
            }
          : undefined,
      cooldownSeconds: environment.demoCooldownSeconds,
      repositoryUrl: environment.repositoryUrl,
    }
    response.json(config)
  })

  app.get("/api/runs", (_request, response) => {
    response.json({ runs: store.list() })
  })

  app.get("/api/runs/:id", (request, response) => {
    const report = store.get(request.params.id)
    if (!report) {
      response.status(404).json({ error: "Run not found", code: "RUN_NOT_FOUND" } satisfies ApiError)
      return
    }
    response.json(report)
  })

  app.post("/api/runs", async (request, response, next) => {
    try {
      const input = RunRequestSchema.parse(request.body)
      const report = await coordinator.start(input)
      response.status(202).json(report)
    } catch (error) {
      next(error)
    }
  })

  if (store.artifactRoot) {
    app.use(
      "/artifacts",
      express.static(store.artifactRoot, {
        fallthrough: false,
        immutable: false,
        maxAge: "5m",
        setHeaders: (response, filePath) => {
          if (filePath.endsWith(".ndjson")) response.setHeader("Content-Type", "application/x-ndjson")
        },
      }),
    )
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof CoordinatorError) {
      if (error.retryAfterSeconds) response.setHeader("Retry-After", error.retryAfterSeconds)
      response.status(error.status).json({
        error: error.message,
        code: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
      } satisfies ApiError)
      return
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: error.issues.map((issue) => issue.message).join("; "),
        code: "INVALID_REQUEST",
      } satisfies ApiError)
      return
    }
    response.status(500).json({
      error: "The request could not be completed.",
      code: "INTERNAL_ERROR",
    } satisfies ApiError)
  })

  return app
}

export function attachProductionClient(app: Express): void {
  const clientDirectory = path.resolve(process.cwd(), "dist-client")
  app.use(express.static(clientDirectory, { maxAge: "1h", index: false }))
  app.use((request, response, next) => {
    if (request.method !== "GET" || !request.accepts("html")) {
      next()
      return
    }
    response.sendFile(path.join(clientDirectory, "index.html"))
  })
}
