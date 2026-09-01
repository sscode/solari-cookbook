import { randomUUID } from "node:crypto"

import type { RunReport, RunTarget } from "../shared/model"
import type { RunRequest } from "../shared/schema"
import { createPipeline, displayIdFromUuid } from "./pipeline"
import { RunStore } from "./store"

export interface RunEngine {
  execute(runId: string, target: RunTarget): Promise<void>
}

interface CoordinatorOptions {
  store: RunStore
  engine?: RunEngine
  publicDemo: boolean
  demoRepository?: string
  demoPullNumber?: number
  cooldownSeconds: number
  now?: () => Date
}

export class CoordinatorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

export class RunCoordinator {
  private readonly store: RunStore
  private readonly engine?: RunEngine
  private readonly publicDemo: boolean
  private readonly demoRepository?: string
  private readonly demoPullNumber?: number
  private readonly cooldownSeconds: number
  private readonly now: () => Date
  private activeRunId?: string
  private lastStartedAt?: number

  constructor(options: CoordinatorOptions) {
    this.store = options.store
    this.engine = options.engine
    this.publicDemo = options.publicDemo
    this.demoRepository = options.demoRepository
    this.demoPullNumber = options.demoPullNumber
    this.cooldownSeconds = options.cooldownSeconds
    this.now = options.now ?? (() => new Date())
  }

  get liveAvailable(): boolean {
    if (!this.engine) return false
    if (!this.publicDemo) return true
    return Boolean(this.demoRepository && this.demoPullNumber)
  }

  async start(request: RunRequest): Promise<RunReport> {
    if (!this.engine) {
      throw new CoordinatorError(
        "Live runs are unavailable until SOLARI_API_KEY is configured.",
        "LIVE_UNAVAILABLE",
        503,
      )
    }

    if (this.activeRunId) {
      const active = this.store.get(this.activeRunId)
      if (active && ["queued", "running"].includes(active.status)) {
        throw new CoordinatorError(
          `${active.displayId} is already collecting evidence.`,
          "RUN_IN_PROGRESS",
          409,
        )
      }
      this.activeRunId = undefined
    }

    const target = this.resolveTarget(request)
    const now = this.now()
    if (this.publicDemo && this.lastStartedAt) {
      const elapsedSeconds = Math.floor((now.getTime() - this.lastStartedAt) / 1_000)
      const retryAfterSeconds = this.cooldownSeconds - elapsedSeconds
      if (retryAfterSeconds > 0) {
        throw new CoordinatorError(
          `The public demo is cooling down. Try again in ${retryAfterSeconds} seconds.`,
          "DEMO_COOLDOWN",
          429,
          retryAfterSeconds,
        )
      }
    }

    const id = randomUUID()
    const timestamp = now.toISOString()
    const report: RunReport = {
      id,
      displayId: displayIdFromUuid(id),
      source: "live",
      status: "queued",
      verdict: "QUEUED — waiting for an isolated environment",
      target,
      createdAt: timestamp,
      updatedAt: timestamp,
      stages: createPipeline(),
      suites: [],
      summary: { passed: 0, failed: 0, warnings: 0, total: 0 },
      environment: {
        sandboxTemplate: "base",
        snapshotRetained: false,
        cleanup: "pending",
      },
      logs: [
        {
          at: timestamp,
          stage: "allocate",
          stream: "system",
          message: "Run accepted; no repository code has touched the host",
        },
      ],
    }

    await this.store.put(report)
    this.activeRunId = id
    this.lastStartedAt = now.getTime()

    void this.engine.execute(id, target).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.update(id, (current) => {
        current.status = "error"
        current.verdict = "ERROR — orchestration stopped unexpectedly"
        current.error = message.slice(0, 1_000)
        current.updatedAt = this.now().toISOString()
      })
    }).finally(() => {
      if (this.activeRunId === id) this.activeRunId = undefined
    })

    return report
  }

  private resolveTarget(request: RunRequest): RunTarget {
    if (this.publicDemo) {
      if (!request.demo) {
        throw new CoordinatorError(
          "The hosted demo only runs its configured public fixture PR. Self-host to audit other repositories.",
          "PUBLIC_DEMO_RESTRICTED",
          403,
        )
      }
      if (!this.demoRepository || !this.demoPullNumber) {
        throw new CoordinatorError(
          "The live demo target has not been configured.",
          "DEMO_TARGET_MISSING",
          503,
        )
      }
      return { repository: this.demoRepository, pullNumber: this.demoPullNumber }
    }

    if (request.demo) {
      if (!this.demoRepository || !this.demoPullNumber) {
        throw new CoordinatorError(
          "Provide a repository and pull request, or configure the demo target.",
          "TARGET_REQUIRED",
          400,
        )
      }
      return { repository: this.demoRepository, pullNumber: this.demoPullNumber }
    }

    if (!request.pullNumber && !request.ref) {
      throw new CoordinatorError(
        "A pull request number or Git ref is required.",
        "REF_REQUIRED",
        400,
      )
    }
    return {
      repository: request.repository,
      pullNumber: request.pullNumber,
      ref: request.ref,
    }
  }
}
