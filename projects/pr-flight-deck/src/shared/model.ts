export type RunStatus = "queued" | "running" | "passed" | "failed" | "error"

export type StageStatus = "pending" | "active" | "passed" | "failed" | "skipped"

export type CheckStatus = "passed" | "failed" | "warning" | "skipped"

export type StageId =
  | "allocate"
  | "checkout"
  | "build"
  | "preview"
  | "desktop"
  | "mobile"
  | "evidence"
  | "cleanup"

export interface RunTarget {
  repository: string
  pullNumber?: number
  ref?: string
  commit?: string
  projectPath?: string
}

export interface PipelineStage {
  id: StageId
  label: string
  status: StageStatus
  detail: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
}

export interface AuditCheck {
  id: string
  category: "journey" | "runtime" | "accessibility" | "network"
  label: string
  status: CheckStatus
  detail: string
  durationMs?: number
}

export interface BrowserSuiteReport {
  id: "desktop" | "mobile"
  label: string
  viewport: {
    width: number
    height: number
  }
  status: "passed" | "failed"
  durationMs: number
  checks: AuditCheck[]
  consoleErrors: string[]
  screenshotUrl?: string
  replayUrl?: string
  replayExpiresInSeconds?: number
  replayEventCount?: number
}

export interface RunLogEntry {
  at: string
  stage: StageId
  stream: "system" | "stdout" | "stderr"
  message: string
}

export interface RunSummary {
  passed: number
  failed: number
  warnings: number
  total: number
}

export interface EnvironmentEvidence {
  sandboxTemplate: string
  snapshotRetained: boolean
  cleanup: "pending" | "complete" | "partial"
}

export interface RunReport {
  id: string
  displayId: string
  source: "showcase" | "live"
  status: RunStatus
  verdict: string
  target: RunTarget
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  previewUrl?: string
  stages: PipelineStage[]
  suites: BrowserSuiteReport[]
  summary: RunSummary
  environment: EnvironmentEvidence
  logs: RunLogEntry[]
  error?: string
}

export type JourneyStep = (
  | { action: "goto"; path: string }
  | { action: "click"; role: "button" | "link"; name: string; exact?: boolean }
  | { action: "fill"; label: string; value: string }
  | { action: "press"; key: string }
  | { action: "expectText"; text: string; exact?: boolean }
  | { action: "expectVisible"; selector: string }
  | { action: "expectUrlContains"; value: string }
) & { checkLabel?: string }

export interface JourneyDefinition {
  id: string
  name: string
  steps: JourneyStep[]
}

export interface FlightDeckProjectConfig {
  version: 1
  projectPath: string
  installCommand?: string
  buildCommand?: string
  startCommand: string
  port: number
  healthPath: string
  journeys: JourneyDefinition[]
}

export interface PublicAppConfig {
  liveAvailable: boolean
  publicDemo: boolean
  demoTarget?: {
    repository: string
    pullNumber: number
  }
  cooldownSeconds: number
  repositoryUrl: string
}

export interface ApiError {
  error: string
  code: string
  retryAfterSeconds?: number
}
