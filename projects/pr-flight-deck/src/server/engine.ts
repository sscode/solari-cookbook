import path from "node:path"

import { Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"
import type { CommandHandle, Sandbox } from "@solarisdk/core"
import type { Page } from "patchright-core"

import type {
  AuditCheck,
  BrowserSuiteReport,
  FlightDeckProjectConfig,
  JourneyStep,
  RunReport,
  RunTarget,
  StageId,
} from "../shared/model"
import { FlightDeckProjectConfigSchema } from "../shared/schema"
import { addLog, summarizeChecks, updateStage } from "./pipeline"
import { RunStore } from "./store"

const WORKSPACE = "/workspace/flight-deck"
const REPLAY_ATTEMPTS = 8

interface EngineOptions {
  apiKey: string
  store: RunStore
}

interface AccessibilityResult {
  missingNames: number
  missingLabels: number
  missingAlts: number
  duplicateIds: number
  mainLandmarks: number
}

class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`${command} exited ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`)
  }
}

export class SolariFlightEngine {
  private readonly apiKey: string
  private readonly store: RunStore

  constructor(options: EngineOptions) {
    this.apiKey = options.apiKey
    this.store = options.store
  }

  async execute(runId: string, target: RunTarget): Promise<void> {
    const compute = new SolariClient({ apiKey: this.apiKey, callTimeoutMs: 120_000 })
    const browsers = new Solari({
      apiKey: this.apiKey,
      timeoutMs: 60_000,
      maxAttempts: 4,
      backoffMs: 750,
    })

    let sandbox: Awaited<ReturnType<typeof compute.sandboxes.create>> | undefined
    let serverProcess: CommandHandle | undefined
    let currentStage: StageId = "allocate"
    let finalStatus: RunReport["status"] = "error"
    let finalVerdict = "ERROR — run did not complete"
    let snapshotRetained = false
    let cleanupComplete = true

    await this.mutate(runId, (report) => {
      report.status = "running"
      report.startedAt = new Date().toISOString()
      report.verdict = "IN FLIGHT — evidence is being collected"
      updateStage(report, "allocate", "active", "Restoring an isolated Solari sandbox")
      addLog(report, "allocate", "system", "Requesting a 2 vCPU / 2 GB isolated sandbox")
    })

    try {
      const allocationStarted = Date.now()
      sandbox = await compute.sandboxes.create({
        template: "base",
        cpu: 2,
        memMb: 2_048,
        timeoutMs: 8 * 60_000,
        lifecycle: { onTimeout: "kill" },
        metadata: { product: "pr-flight-deck", runId },
      })
      await sandbox.connect()
      await this.runCommand(runId, sandbox, "allocate", "date", [
        "-u",
        "-s",
        new Date().toISOString(),
      ])
      await this.appendLog(
        runId,
        "allocate",
        "system",
        "Sandbox clock synchronized before verified outbound TLS",
      )
      await this.completeStage(
        runId,
        "allocate",
        `Sandbox ready in ${formatDuration(Date.now() - allocationStarted)}`,
      )

      currentStage = "checkout"
      await this.activateStage(runId, currentStage, "Fetching the pull request without host credentials")
      const commit = await this.checkoutTarget(runId, sandbox, target)

      const rawConfig = await sandbox.files.readText(path.posix.join(WORKSPACE, "flightdeck.config.json"))
      const config = FlightDeckProjectConfigSchema.parse(JSON.parse(rawConfig))
      const projectRoot = path.posix.join(WORKSPACE, config.projectPath)
      await this.mutate(runId, (report) => {
        report.target.commit = commit.slice(0, 12)
        report.target.projectPath = config.projectPath
        updateStage(report, "checkout", "passed", `Checked out ${commit.slice(0, 12)}`)
        addLog(report, "checkout", "stdout", `Loaded flightdeck.config.json for ${config.projectPath}`)
      })

      currentStage = "build"
      await this.activateStage(runId, currentStage, "Installing and building inside the sandbox")
      if (config.installCommand) {
        await this.runShell(runId, sandbox, currentStage, config.installCommand, projectRoot, 180_000)
      }
      if (config.buildCommand) {
        await this.runShell(runId, sandbox, currentStage, config.buildCommand, projectRoot, 180_000)
      }
      await this.completeStage(
        runId,
        currentStage,
        config.installCommand || config.buildCommand
          ? "Install and build commands completed"
          : "No build step required by target configuration",
      )

      currentStage = "preview"
      await this.activateStage(runId, currentStage, `Starting application on port ${config.port}`)
      serverProcess = await sandbox.commands.start("sh", {
        args: ["-lc", config.startCommand],
        cwd: projectRoot,
      })
      void serverProcess.wait().catch((error) =>
        this.appendLogBestEffort(
          runId,
          "cleanup",
          "stderr",
          `Preview process channel closed during cleanup: ${describeError(error)}`,
        ),
      )
      serverProcess.onData(({ stream, data }) => {
        void this.appendLog(runId, "preview", stream, data)
      })

      const preview = await sandbox.previewUrl(config.port)
      await this.waitForPreview(runId, preview.url, config.healthPath, preview.token)
      await this.mutate(runId, (report) => {
        report.previewUrl = preview.url
        updateStage(report, "preview", "passed", `Preview healthy on port ${config.port}`)
      })

      currentStage = "desktop"
      await this.activateStage(runId, currentStage, "Running recorded checks at 1440 × 900")
      const desktop = await this.runBrowserSuite(
        runId,
        browsers,
        preview.url,
        preview.token,
        config,
        "desktop",
        "Desktop Chrome",
        { width: 1_440, height: 900 },
      )
      await this.mutate(runId, (report) => {
        report.suites.push(desktop)
        updateStage(
          report,
          "desktop",
          desktop.status === "passed" ? "passed" : "failed",
          suiteDetail(desktop),
        )
      })

      currentStage = "mobile"
      await this.activateStage(runId, currentStage, "Running recorded checks at 390 × 844")
      const mobile = await this.runBrowserSuite(
        runId,
        browsers,
        preview.url,
        preview.token,
        config,
        "mobile",
        "Mobile Chrome",
        { width: 390, height: 844 },
      )
      await this.mutate(runId, (report) => {
        report.suites.push(mobile)
        updateStage(
          report,
          "mobile",
          mobile.status === "passed" ? "passed" : "failed",
          suiteDetail(mobile),
        )
      })

      const suites = [desktop, mobile]
      const failed = suites.some((suite) => suite.status === "failed")
      currentStage = "evidence"
      await this.activateStage(
        runId,
        currentStage,
        failed ? "Retaining artifacts and a reproducible failure snapshot" : "Retaining artifacts",
      )

      if (failed) {
        await sandbox.snapshot(`flight-deck-${runId.slice(0, 8)}`)
        snapshotRetained = true
        await this.appendLog(runId, "evidence", "system", "Failure snapshot retained in Solari")
      }
      await this.completeStage(
        runId,
        currentStage,
        snapshotRetained
          ? "Screenshots, replays, and failure snapshot retained"
          : "Screenshots and replays retained",
      )

      finalStatus = failed ? "failed" : "passed"
      finalVerdict = failed
        ? "HOLD — recorded checks found a regression"
        : "CLEAR — all recorded checks passed"
    } catch (error) {
      const message = describeError(error)
      await this.mutate(runId, (report) => {
        updateStage(report, currentStage, "failed", message)
        addLog(report, currentStage, "stderr", message)
        report.error = message
      })

      if (sandbox) {
        try {
          await sandbox.snapshot(`flight-deck-error-${runId.slice(0, 8)}`)
          snapshotRetained = true
          await this.appendLog(runId, currentStage, "system", "Error snapshot retained in Solari")
        } catch (snapshotError) {
          await this.appendLog(
            runId,
            currentStage,
            "stderr",
            `Could not retain snapshot: ${describeError(snapshotError)}`,
          )
        }
      }
    } finally {
      currentStage = "cleanup"
      try {
        await this.activateStage(runId, currentStage, "Releasing every remote resource")
      } catch {
        // Evidence persistence must never stand between us and resource release.
      }

      if (serverProcess) {
        try {
          await withTimeout(serverProcess.kill(), 15_000, "Preview process release")
        } catch (error) {
          cleanupComplete = false
          await this.appendLogBestEffort(
            runId,
            "cleanup",
            "stderr",
            `Preview process release warning: ${describeError(error)}`,
          )
        }
      }

      try {
        await withTimeout(browsers.close(), 15_000, "Browser client release")
      } catch (error) {
        cleanupComplete = false
        await this.appendLogBestEffort(
          runId,
          "cleanup",
          "stderr",
          `Browser client release warning: ${describeError(error)}`,
        )
      }

      if (sandbox) {
        try {
          await withTimeout(sandbox.kill(), 30_000, "Sandbox release")
        } catch (error) {
          cleanupComplete = false
          await this.appendLogBestEffort(
            runId,
            "cleanup",
            "stderr",
            `Sandbox release warning: ${describeError(error)}`,
          )
        }
      }

      if (!cleanupComplete) {
        finalStatus = "error"
        finalVerdict = "ERROR — remote cleanup needs attention"
      }

      const finishedAt = new Date()
      await this.mutate(runId, (report) => {
        updateStage(
          report,
          "cleanup",
          cleanupComplete ? "passed" : "failed",
          cleanupComplete ? "Browser sessions released; sandbox destroyed" : "Cleanup needs attention",
          finishedAt,
        )
        report.environment.snapshotRetained = snapshotRetained
        report.environment.cleanup = cleanupComplete ? "complete" : "partial"
        report.status = finalStatus
        report.verdict = finalVerdict
        report.finishedAt = finishedAt.toISOString()
        report.durationMs = report.startedAt
          ? finishedAt.getTime() - Date.parse(report.startedAt)
          : undefined
        report.summary = summarizeChecks(report.suites.flatMap((suite) => suite.checks))
      })
    }
  }

  private async checkoutTarget(
    runId: string,
    sandbox: Sandbox,
    target: RunTarget,
  ): Promise<string> {
    await this.runCommand(runId, sandbox, "checkout", "git", [
      "clone",
      "--filter=blob:none",
      "--no-tags",
      target.repository,
      WORKSPACE,
    ])

    if (target.pullNumber) {
      const branch = `flight-deck-pr-${target.pullNumber}`
      await this.runCommand(
        runId,
        sandbox,
        "checkout",
        "git",
        ["fetch", "origin", `pull/${target.pullNumber}/head:${branch}`],
        WORKSPACE,
      )
      await this.runCommand(runId, sandbox, "checkout", "git", ["checkout", branch], WORKSPACE)
    } else if (target.ref) {
      await this.runCommand(
        runId,
        sandbox,
        "checkout",
        "git",
        ["fetch", "origin", target.ref],
        WORKSPACE,
      )
      await this.runCommand(runId, sandbox, "checkout", "git", ["checkout", "--detach", "FETCH_HEAD"], WORKSPACE)
    }

    const result = await this.runCommand(
      runId,
      sandbox,
      "checkout",
      "git",
      ["rev-parse", "HEAD"],
      WORKSPACE,
    )
    return result.stdout.trim()
  }

  private async runBrowserSuite(
    runId: string,
    client: Solari,
    previewUrl: string,
    previewToken: string | undefined,
    config: FlightDeckProjectConfig,
    id: BrowserSuiteReport["id"],
    label: string,
    viewport: BrowserSuiteReport["viewport"],
  ): Promise<BrowserSuiteReport> {
    const startedAt = Date.now()
    const checks: AuditCheck[] = []
    const consoleErrors: string[] = []
    let browser: Awaited<ReturnType<Solari["launch"]>> | undefined
    let page: Page | undefined
    let screenshotUrl: string | undefined
    let replayUrl: string | undefined
    let replayExpiresInSeconds: number | undefined
    let replayEventCount: number | undefined
    let sessionId: string | undefined

    try {
      browser = await client.launch({ recording: true, retries: 2, probe: true })
      sessionId = browser.id
      const context = await browser.newContext({
        viewport,
        extraHTTPHeaders: previewToken
          ? { Authorization: `Bearer ${previewToken}` }
          : undefined,
      })
      page = await context.newPage()
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500))
      })
      page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 500)))

      const navigationStarted = Date.now()
      const response = await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
      const status = response?.status() ?? 0
      checks.push({
        id: `${id}-http`,
        category: "network",
        label: "Preview responds",
        status: status > 0 && status < 400 ? "passed" : "failed",
        detail: status > 0 ? `HTTP ${status}` : "Navigation returned no response",
        durationMs: Date.now() - navigationStarted,
      })

      for (const journey of config.journeys) {
        let blocked = false
        for (const [index, step] of journey.steps.entries()) {
          const checkId = `${id}-${journey.id}-${index + 1}`
          if (blocked) {
            checks.push({
              id: checkId,
              category: "journey",
              label: stepLabel(step),
              status: "skipped",
              detail: `Skipped after an earlier “${journey.name}” failure`,
            })
            continue
          }
          const stepStarted = Date.now()
          try {
            await executeStep(page, previewUrl, step)
            checks.push({
              id: checkId,
              category: "journey",
              label: stepLabel(step),
              status: "passed",
              detail: stepSuccessDetail(step),
              durationMs: Date.now() - stepStarted,
            })
          } catch (error) {
            blocked = true
            checks.push({
              id: checkId,
              category: "journey",
              label: stepLabel(step),
              status: "failed",
              detail: stepFailureDetail(step, error),
              durationMs: Date.now() - stepStarted,
            })
          }
        }
      }

      const title = await page.title()
      checks.push({
        id: `${id}-title`,
        category: "runtime",
        label: "Document has a title",
        status: title.trim() ? "passed" : "failed",
        detail: title.trim() ? `“${title.trim().slice(0, 120)}”` : "The document title is empty",
      })

      if (id === "mobile") {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
        checks.push({
          id: `${id}-overflow`,
          category: "runtime",
          label: "No horizontal overflow",
          status: overflow ? "failed" : "passed",
          detail: overflow ? "Content extends beyond the viewport" : `${viewport.width} px layout fits`,
        })
      }

      const accessibility = await inspectAccessibility(page)
      checks.push(...accessibilityChecks(id, accessibility))
      checks.push({
        id: `${id}-console`,
        category: "runtime",
        label: "No console exceptions",
        status: consoleErrors.length === 0 ? "passed" : "failed",
        detail:
          consoleErrors.length === 0
            ? "No uncaught browser errors"
            : `${consoleErrors.length} error${consoleErrors.length === 1 ? "" : "s"}: ${consoleErrors[0]}`,
      })

      const screenshot = await page.screenshot({ fullPage: true, type: "png" })
      screenshotUrl = await this.store.writeArtifact(runId, `${id}.png`, screenshot)
    } catch (error) {
      checks.push({
        id: `${id}-infrastructure`,
        category: "runtime",
        label: "Browser run completes",
        status: "failed",
        detail: describeError(error),
      })
    } finally {
      if (page) {
        try {
          await page.close()
        } catch {
          // Browser release below remains the authoritative cleanup path.
        }
      }
      if (browser) {
        try {
          await browser.close()
        } catch {
          // Solari.close() in the outer finally provides a second cleanup path.
        }
      }
    }

    if (sessionId) {
      for (let attempt = 1; attempt <= REPLAY_ATTEMPTS; attempt += 1) {
        await sleep(1_500)
        try {
          const [replay, bytes] = await Promise.all([
            client.sessions.getReplayUrl(sessionId),
            client.sessions.downloadReplay(sessionId),
          ])
          replayUrl = replay.url
          replayExpiresInSeconds = replay.expiresInSeconds
          replayEventCount = countLines(bytes)
          await this.store.writeArtifact(runId, `${id}.ndjson`, bytes)
          break
        } catch (error) {
          if (attempt === REPLAY_ATTEMPTS) {
            await this.appendLog(
              runId,
              id,
              "stderr",
              `Replay was not ready after ${REPLAY_ATTEMPTS} attempts: ${describeError(error)}`,
            )
          }
        }
      }
    }

    return {
      id,
      label,
      viewport,
      status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
      durationMs: Date.now() - startedAt,
      checks,
      consoleErrors,
      screenshotUrl,
      replayUrl,
      replayExpiresInSeconds,
      replayEventCount,
    }
  }

  private async runShell(
    runId: string,
    sandbox: Sandbox,
    stage: StageId,
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<void> {
    await this.runCommand(runId, sandbox, stage, "sh", ["-lc", command], cwd, timeoutMs)
  }

  private async runCommand(
    runId: string,
    sandbox: Sandbox,
    stage: StageId,
    command: string,
    args: string[],
    cwd?: string,
    timeoutMs = 120_000,
  ) {
    await this.appendLog(runId, stage, "system", `$ ${command} ${args.map(redactArgument).join(" ")}`)
    const result = await sandbox.commands.run(command, {
      args,
      cwd,
      timeoutMs,
      onStdout: (data) => void this.appendLog(runId, stage, "stdout", data),
      onStderr: (data) => void this.appendLog(runId, stage, "stderr", data),
    })
    if (result.exitCode !== 0) {
      throw new CommandFailedError(command, result.exitCode, result.stderr.trim())
    }
    return result
  }

  private async waitForPreview(
    runId: string,
    previewUrl: string,
    healthPath: string,
    previewToken?: string,
  ): Promise<void> {
    const healthUrl = new URL(healthPath, ensureTrailingSlash(previewUrl)).toString()
    let lastStatus = "no response"
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        const response = await fetch(healthUrl, {
          headers: previewToken ? { Authorization: `Bearer ${previewToken}` } : undefined,
          signal: AbortSignal.timeout(5_000),
        })
        lastStatus = `HTTP ${response.status}`
        if (response.ok) {
          await this.appendLog(runId, "preview", "system", `Health check passed (${lastStatus})`)
          return
        }
      } catch (error) {
        lastStatus = describeError(error)
      }
      await sleep(1_000)
    }
    throw new Error(`Preview did not become healthy: ${lastStatus}`)
  }

  private async activateStage(runId: string, id: StageId, detail: string): Promise<void> {
    await this.mutate(runId, (report) => {
      updateStage(report, id, "active", detail)
      addLog(report, id, "system", detail)
    })
  }

  private async completeStage(runId: string, id: StageId, detail: string): Promise<void> {
    await this.mutate(runId, (report) => {
      updateStage(report, id, "passed", detail)
      addLog(report, id, "system", detail)
    })
  }

  private async appendLog(
    runId: string,
    stage: StageId,
    stream: "system" | "stdout" | "stderr",
    message: string,
  ): Promise<void> {
    await this.mutate(runId, (report) => addLog(report, stage, stream, message))
  }

  private async appendLogBestEffort(
    runId: string,
    stage: StageId,
    stream: "system" | "stdout" | "stderr",
    message: string,
  ): Promise<void> {
    try {
      await this.appendLog(runId, stage, stream, message)
    } catch {
      // Cleanup continues even if evidence storage is unavailable.
    }
  }

  private async mutate(runId: string, mutation: (report: RunReport) => void): Promise<void> {
    await this.store.update(runId, mutation)
  }
}

async function executeStep(page: Page, previewUrl: string, step: JourneyStep): Promise<void> {
  switch (step.action) {
    case "goto":
      await page.goto(new URL(step.path, ensureTrailingSlash(previewUrl)).toString(), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      return
    case "click":
      await page.getByRole(step.role, { name: step.name, exact: step.exact }).click({ timeout: 8_000 })
      return
    case "fill":
      await page.getByLabel(step.label, { exact: true }).fill(step.value, { timeout: 8_000 })
      return
    case "press":
      await page.keyboard.press(step.key)
      return
    case "expectText":
      await page.getByText(step.text, { exact: step.exact }).first().waitFor({
        state: "visible",
        timeout: 5_000,
      })
      return
    case "expectVisible":
      await page.locator(step.selector).first().waitFor({ state: "visible", timeout: 5_000 })
      return
    case "expectUrlContains":
      await page.waitForFunction(
        (value) => window.location.href.includes(value),
        step.value,
        { timeout: 8_000 },
      )
  }
}

async function inspectAccessibility(page: Page): Promise<AccessibilityResult> {
  return page.evaluate(() => {
    const hasName = (element: Element) => {
      const text = element.textContent?.trim()
      return Boolean(text || element.getAttribute("aria-label") || element.getAttribute("title"))
    }
    const controls = [...document.querySelectorAll("button, a[href]")]
    const inputs = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")]
    const labels = [...document.querySelectorAll("label")]
    const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id)
    return {
      missingNames: controls.filter((element) => !hasName(element)).length,
      missingLabels: inputs.filter((element) => {
        const id = element.getAttribute("id")
        return !(
          element.getAttribute("aria-label") ||
          element.getAttribute("aria-labelledby") ||
          (id && labels.some((label) => label.htmlFor === id))
        )
      }).length,
      missingAlts: [...document.querySelectorAll("img:not([alt])")].length,
      duplicateIds: ids.length - new Set(ids).size,
      mainLandmarks: document.querySelectorAll("main").length,
    }
  })
}

function accessibilityChecks(id: string, result: AccessibilityResult): AuditCheck[] {
  const checks: AuditCheck[] = [
    {
      id: `${id}-accessible-names`,
      category: "accessibility",
      label: "Interactive controls have names",
      status: result.missingNames === 0 ? "passed" : "failed",
      detail:
        result.missingNames === 0
          ? "Every button and link has a readable name"
          : `${result.missingNames} control${result.missingNames === 1 ? " is" : "s are"} unnamed`,
    },
    {
      id: `${id}-form-labels`,
      category: "accessibility",
      label: "Form fields have labels",
      status: result.missingLabels === 0 ? "passed" : "failed",
      detail:
        result.missingLabels === 0
          ? "Every form field is labelled"
          : `${result.missingLabels} field${result.missingLabels === 1 ? " is" : "s are"} unlabelled`,
    },
    {
      id: `${id}-image-alts`,
      category: "accessibility",
      label: "Images declare alt text",
      status: result.missingAlts === 0 ? "passed" : "warning",
      detail:
        result.missingAlts === 0
          ? "Every image declares alt text"
          : `${result.missingAlts} image${result.missingAlts === 1 ? " is" : "s are"} missing alt`,
    },
    {
      id: `${id}-duplicate-ids`,
      category: "accessibility",
      label: "Element IDs are unique",
      status: result.duplicateIds === 0 ? "passed" : "failed",
      detail:
        result.duplicateIds === 0
          ? "No duplicate IDs detected"
          : `${result.duplicateIds} duplicate ID${result.duplicateIds === 1 ? "" : "s"}`,
    },
  ]
  if (result.mainLandmarks !== 1) {
    checks.push({
      id: `${id}-main-landmark`,
      category: "accessibility",
      label: "Page has one main landmark",
      status: "warning",
      detail: `Found ${result.mainLandmarks} main landmarks`,
    })
  }
  return checks
}

function stepLabel(step: JourneyStep): string {
  if (step.checkLabel) return step.checkLabel
  switch (step.action) {
    case "goto":
      return `Open ${step.path}`
    case "click":
      return `Click “${step.name}”`
    case "fill":
      return `Fill “${step.label}”`
    case "press":
      return `Press ${step.key}`
    case "expectText":
      return `Find “${step.text}”`
    case "expectVisible":
      return `Show ${step.selector}`
    case "expectUrlContains":
      return `URL contains “${step.value}”`
  }
}

function stepFailureDetail(step: JourneyStep, error: unknown): string {
  switch (step.action) {
    case "goto":
      return `Could not open ${step.path}: ${firstErrorLine(error)}`
    case "click":
      return `Could not click the ${step.role} “${step.name}” within 8 seconds`
    case "fill":
      return `Could not fill “${step.label}” within 8 seconds`
    case "press":
      return `Could not press ${step.key}: ${firstErrorLine(error)}`
    case "expectText":
      return `Expected visible text “${step.text}” within 5 seconds`
    case "expectVisible":
      return `Expected ${step.selector} to be visible within 5 seconds`
    case "expectUrlContains":
      return `Expected the URL to include “${step.value}” within 8 seconds`
  }
}

function stepSuccessDetail(step: JourneyStep): string {
  if (step.action === "expectText") return `Found “${step.text}”`
  if (step.action === "expectVisible") return `${step.selector} is visible`
  if (step.action === "expectUrlContains") return `URL includes “${step.value}”`
  return "Action completed"
}

function suiteDetail(suite: BrowserSuiteReport): string {
  const failed = suite.checks.filter((check) => check.status === "failed").length
  return failed === 0
    ? `${suite.checks.length} checks passed`
    : `${failed} of ${suite.checks.length} checks failed`
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1_000)
  return String(error).slice(0, 1_000)
}

function firstErrorLine(error: unknown): string {
  return describeError(error).split("\n", 1)[0] ?? "Unknown browser error"
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(2)} s`
}

function redactArgument(argument: string): string {
  if (/token|secret|password|key=/i.test(argument)) return "[redacted]"
  return /\s/.test(argument) ? JSON.stringify(argument).slice(0, 240) : argument.slice(0, 240)
}

function countLines(bytes: Uint8Array): number {
  let lines = 0
  for (const byte of bytes) if (byte === 10) lines += 1
  return lines + (bytes.length > 0 && bytes.at(-1) !== 10 ? 1 : 0)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
