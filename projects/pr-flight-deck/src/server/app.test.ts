import request from "supertest"
import { describe, expect, it } from "vitest"

import type { AppEnvironment } from "./config"
import { createApp } from "./app"
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

function testApp() {
  const store = new RunStore()
  const coordinator = new RunCoordinator({
    store,
    publicDemo: true,
    demoRepository: environment.demoRepository,
    demoPullNumber: environment.demoPullNumber,
    cooldownSeconds: environment.demoCooldownSeconds,
  })
  return createApp({ environment, store, coordinator })
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
})
