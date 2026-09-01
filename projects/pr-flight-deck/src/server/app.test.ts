import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"

import type { AppEnvironment } from "./config"
import { attachProductionClient, createApp } from "./app"
import { RunCoordinator } from "./coordinator"
import { RunStore } from "./store"

const environment: AppEnvironment = {
  nodeEnv: "test",
  port: 3_000,
  publicDemo: true,
  demoRepository: "https://github.com/acme/rocket",
  demoPullNumber: 7,
  demoCooldownSeconds: 1_800,
  dataDirectory: "/tmp/pr-flight-deck-test",
  repositoryUrl: "https://github.com/acme/rocket",
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

function testApp(options: { environment?: AppEnvironment; logStream?: { write(message: string): void } } = {}) {
  const store = new RunStore()
  const appEnvironment = options.environment ?? environment
  const coordinator = new RunCoordinator({
    store,
    publicDemo: appEnvironment.publicDemo,
    demoRepository: appEnvironment.demoRepository,
    demoPullNumber: appEnvironment.demoPullNumber,
    cooldownSeconds: appEnvironment.demoCooldownSeconds,
  })
  return createApp({
    environment: appEnvironment,
    store,
    coordinator,
    logStream: options.logStream,
  })
}

describe("Flight Deck API", () => {
  it("reports service health and browser-safe headers", async () => {
    const response = await request(testApp()).get("/api/health").expect(200)
    expect(response.body).toEqual({ ok: true, service: "pr-flight-deck" })
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'")
    expect(response.headers["x-powered-by"]).toBeUndefined()
  })

  it("ships with a retained showcase report", async () => {
    const response = await request(testApp()).get("/api/runs").expect(200)
    expect(response.body.runs).toHaveLength(1)
    expect(response.body.runs[0]).toMatchObject({ source: "showcase", status: "failed" })
  })

  it("rejects malformed run bodies", async () => {
    const response = await request(testApp()).post("/api/runs").send({ demo: "yes" }).expect(400)
    expect(response.body.code).toBe("INVALID_REQUEST")
  })

  it("redacts credentials from request logs", async () => {
    const lines: string[] = []
    const app = testApp({ logStream: { write: (message) => lines.push(message) } })

    await request(app)
      .get("/api/health")
      .set("Cookie", "flight-session=do-not-log-this")
      .set("Authorization", "Bearer do-not-log-that")
      .expect(200)

    const output = lines.join("\n")
    expect(output).toContain("[redacted]")
    expect(output).not.toContain("do-not-log-this")
    expect(output).not.toContain("do-not-log-that")
  })

  it("serves SPA routes without disguising missing assets as HTML", async () => {
    const clientDirectory = await mkdtemp(path.join(os.tmpdir(), "flight-deck-client-"))
    temporaryDirectories.push(clientDirectory)
    await writeFile(path.join(clientDirectory, "index.html"), "<!doctype html><title>Flight Deck test</title>")
    const app = testApp()
    attachProductionClient(app, clientDirectory)

    await request(app).get("/runs/demo").set("Accept", "text/html").expect(200, /Flight Deck test/)
    await request(app).get("/missing.ico").set("Accept", "image/*,*/*").expect(404)
  })
})
