import type {
  AuditCheck,
  PipelineStage,
  RunLogEntry,
  RunReport,
  RunSummary,
  StageId,
  StageStatus,
} from "../shared/model"

const stageDefinitions: Array<Pick<PipelineStage, "id" | "label">> = [
  { id: "allocate", label: "Isolate" },
  { id: "checkout", label: "Checkout" },
  { id: "build", label: "Build" },
  { id: "preview", label: "Expose" },
  { id: "desktop", label: "Desktop run" },
  { id: "mobile", label: "Mobile run" },
  { id: "evidence", label: "Retain" },
  { id: "cleanup", label: "Release" },
]

export function createPipeline(): PipelineStage[] {
  return stageDefinitions.map((stage) => ({
    ...stage,
    status: "pending",
    detail: "Waiting",
  }))
}

export function updateStage(
  report: RunReport,
  id: StageId,
  status: StageStatus,
  detail: string,
  now = new Date(),
): void {
  const stage = report.stages.find((candidate) => candidate.id === id)
  if (!stage) return

  const timestamp = now.toISOString()
  if (status === "active" && !stage.startedAt) stage.startedAt = timestamp
  if (["passed", "failed", "skipped"].includes(status)) {
    stage.finishedAt = timestamp
    if (!stage.startedAt) stage.startedAt = timestamp
    stage.durationMs = Date.parse(stage.finishedAt) - Date.parse(stage.startedAt)
  }
  stage.status = status
  stage.detail = detail
  report.updatedAt = timestamp
}

export function addLog(
  report: RunReport,
  stage: StageId,
  stream: RunLogEntry["stream"],
  message: string,
  now = new Date(),
): void {
  const clean = message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim()
  if (!clean) return
  for (const line of clean.split("\n")) {
    report.logs.push({
      at: now.toISOString(),
      stage,
      stream,
      message: line.slice(0, 1_000),
    })
  }
  if (report.logs.length > 400) report.logs.splice(0, report.logs.length - 400)
  report.updatedAt = now.toISOString()
}

export function summarizeChecks(checks: AuditCheck[]): RunSummary {
  return checks.reduce<RunSummary>(
    (summary, check) => {
      if (check.status === "passed") summary.passed += 1
      if (check.status === "failed") summary.failed += 1
      if (check.status === "warning") summary.warnings += 1
      summary.total += 1
      return summary
    },
    { passed: 0, failed: 0, warnings: 0, total: 0 },
  )
}

export function displayIdFromUuid(id: string): string {
  return `FD-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`
}
