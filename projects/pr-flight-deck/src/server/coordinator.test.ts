import { setImmediate as waitForImmediate } from "node:timers/promises"

import { describe, expect, it, vi } from "vitest"

import type { RunTarget } from "../shared/model"
import { CoordinatorError, RunCoordinator, type RunEngine } from "./coordinator"
import { RunStore } from "./store"

function coordinator(overrides: Partial<ConstructorParameters<typeof RunCoordinator>[0]> = {}) {
  const execute = vi.fn(async (_runId: string, _target: RunTarget) => undefined)
  const engine: RunEngine = { execute }
  const instance = new RunCoordinator({
    store: new RunStore(),
    engine,
    publicDemo: true,
    demoRepository: "https://github.com/acme/rocket",
    demoPullNumber: 7,
    cooldownSeconds: 60,
    ...overrides,
  })
  return { instance, execute }
}

describe("RunCoordinator", () => {
  it("pins hosted runs to the configured fixture", async () => {
    const { instance, execute } = coordinator()
    const report = await instance.start({ demo: true })

    expect(report.target).toEqual({ repository: "https://github.com/acme/rocket", pullNumber: 7 })
    expect(execute).toHaveBeenCalledWith(report.id, report.target)
  })

  it("does not let public users choose arbitrary repositories", async () => {
    const { instance } = coordinator()
    const request = instance.start({
      demo: false,
      repository: "https://github.com/attacker/repository",
      pullNumber: 1,
    })

    await expect(request).rejects.toMatchObject({
      code: "PUBLIC_DEMO_RESTRICTED",
      status: 403,
    })
  })

  it("enforces a cooldown after a public run", async () => {
    let now = new Date("2026-09-01T00:00:00.000Z")
    const { instance } = coordinator({ now: () => now })
    await instance.start({ demo: true })
    await waitForImmediate()
    now = new Date("2026-09-01T00:00:12.000Z")

    await expect(instance.start({ demo: true })).rejects.toMatchObject({
      code: "DEMO_COOLDOWN",
      retryAfterSeconds: 48,
    })
  })

  it("fails closed when the API key is absent", async () => {
    const instance = new RunCoordinator({
      store: new RunStore(),
      publicDemo: true,
      demoRepository: "https://github.com/acme/rocket",
      demoPullNumber: 7,
      cooldownSeconds: 60,
    })

    await expect(instance.start({ demo: true })).rejects.toMatchObject({
      code: "LIVE_UNAVAILABLE",
      status: 503,
    })
  })
})
