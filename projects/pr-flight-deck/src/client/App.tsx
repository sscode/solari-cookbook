import { useCallback, useEffect, useMemo, useState } from "react"

import type {
  ApiError,
  BrowserSuiteReport,
  PipelineStage,
  PublicAppConfig,
  RunReport,
} from "../shared/model"
import { ReplayViewer } from "./ReplayViewer"

type LoadState = "loading" | "ready" | "error"

export function App() {
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [config, setConfig] = useState<PublicAppConfig>()
  const [runs, setRuns] = useState<RunReport[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [activeSuiteId, setActiveSuiteId] = useState<BrowserSuiteReport["id"]>("desktop")
  const [launching, setLaunching] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [replaySelection, setReplaySelection] = useState<{
    runId: string
    suite: BrowserSuiteReport
  }>()

  const load = useCallback(async () => {
    try {
      const [configResponse, runsResponse] = await Promise.all([fetch("/api/config"), fetch("/api/runs")])
      if (!configResponse.ok || !runsResponse.ok) throw new Error("Flight Deck did not answer")
      const nextConfig = (await configResponse.json()) as PublicAppConfig
      const payload = (await runsResponse.json()) as { runs: RunReport[] }
      setConfig(nextConfig)
      setRuns(payload.runs)
      setSelectedId((current) => current ?? payload.runs[0]?.id)
      setLoadState("ready")
    } catch {
      setLoadState("error")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const selected = runs.find((run) => run.id === selectedId) ?? runs[0]
  const isActive = selected && ["queued", "running"].includes(selected.status)

  useEffect(() => {
    if (!isActive || !selected) return
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/runs/${selected.id}`)
      if (!response.ok) return
      const next = (await response.json()) as RunReport
      setRuns((current) => [next, ...current.filter((run) => run.id !== next.id)])
      if (!["queued", "running"].includes(next.status)) setLaunching(false)
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [isActive, selected])

  const launchDemo = async () => {
    setLaunching(true)
    setNotice(undefined)
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ demo: true }),
      })
      const payload = (await response.json()) as RunReport | ApiError
      if (!response.ok) {
        const error = payload as ApiError
        setNotice(error.error)
        setLaunching(false)
        return
      }
      const report = payload as RunReport
      setRuns((current) => [report, ...current.filter((run) => run.id !== report.id)])
      setSelectedId(report.id)
      setActiveSuiteId("desktop")
    } catch {
      setNotice("The launch request could not reach Flight Deck.")
      setLaunching(false)
    }
  }

  if (loadState === "loading") return <LoadingScreen />
  if (loadState === "error" || !config || !selected) return <ErrorScreen onRetry={load} />

  const activeSuite = selected.suites.find((suite) => suite.id === activeSuiteId) ?? selected.suites[0]

  return (
    <div className="app-shell">
      <TopBar config={config} />
      <div className="workspace">
        <RunRail runs={runs} selectedId={selected.id} onSelect={setSelectedId} />
        <main className="report" aria-live="polite">
          <ReportHeader
            report={selected}
            config={config}
            launching={launching}
            notice={notice}
            onLaunch={launchDemo}
          />
          <Pipeline stages={selected.stages} />
          <section className="evidence-layout" aria-label="Run evidence">
            <EvidencePanel
              report={selected}
              activeSuite={activeSuite}
              activeSuiteId={activeSuiteId}
              onSuiteChange={setActiveSuiteId}
              onReplay={() => {
                if (activeSuite) setReplaySelection({ runId: selected.id, suite: activeSuite })
              }}
            />
            <ChecksPanel suite={activeSuite} report={selected} />
          </section>
          <RunLog report={selected} />
        </main>
      </div>
      {replaySelection ? (
        <ReplayViewer
          runId={replaySelection.runId}
          suite={replaySelection.suite}
          onClose={() => setReplaySelection(undefined)}
        />
      ) : null}
    </div>
  )
}

function TopBar({ config }: { config: PublicAppConfig }) {
  return (
    <header className="topbar">
      <a className="brand" href="#top" aria-label="PR Flight Deck home">
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="brand-copy">
          <strong>PR Flight Deck</strong>
          <small>Recorded release evidence</small>
        </span>
      </a>
      <div className="topbar-status">
        <span className={`live-indicator ${config.liveAvailable ? "is-live" : ""}`} />
        <span>{config.liveAvailable ? "Solari link ready" : "Showcase mode"}</span>
        <a href={config.repositoryUrl} target="_blank" rel="noreferrer">
          View source <ArrowIcon />
        </a>
      </div>
    </header>
  )
}

function RunRail({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunReport[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <aside className="run-rail" aria-label="Flight history">
      <div className="rail-heading">
        <p className="eyebrow">Flight history</p>
        <span>{String(runs.length).padStart(2, "0")}</span>
      </div>
      <div className="run-list">
        {runs.map((run) => (
          <button
            key={run.id}
            className={`run-item ${run.id === selectedId ? "is-selected" : ""}`}
            onClick={() => onSelect(run.id)}
            aria-pressed={run.id === selectedId}
          >
            <span className={`status-beacon status-${run.status}`} aria-hidden="true" />
            <span>
              <strong>{run.displayId}</strong>
              <small>{targetLabel(run)}</small>
            </span>
            <time dateTime={run.createdAt}>{shortTime(run.createdAt)}</time>
          </button>
        ))}
      </div>
      <div className="rail-note">
        <LockIcon />
        <p>
          Repository code runs in a remote microVM. The host receives evidence, never the build.
        </p>
      </div>
    </aside>
  )
}

function ReportHeader({
  report,
  config,
  launching,
  notice,
  onLaunch,
}: {
  report: RunReport
  config: PublicAppConfig
  launching: boolean
  notice?: string
  onLaunch: () => void
}) {
  const repository = repositoryName(report.target.repository)
  return (
    <section className="report-header" id="top">
      <div className="report-title-block">
        <div className="report-kicker">
          <span>{report.source === "showcase" ? "Recorded demonstration" : "Live Solari run"}</span>
          <span className="kicker-rule" />
          <time dateTime={report.createdAt}>{formatDate(report.createdAt)}</time>
        </div>
        <h1>{repository}</h1>
        <div className="target-line">
          <span className="branch-chip">PR #{report.target.pullNumber ?? "—"}</span>
          <code>{report.target.commit ?? "awaiting checkout"}</code>
          {report.target.projectPath && <span>{report.target.projectPath}</span>}
        </div>
      </div>
      <div className="launch-control">
        <button
          className="launch-button"
          onClick={onLaunch}
          disabled={!config.liveAvailable || launching}
        >
          <span>{launching ? "In flight" : "Run live demo"}</span>
          <span className="launch-glyph" aria-hidden="true">
            {launching ? <SpinnerIcon /> : <LaunchIcon />}
          </span>
        </button>
        <p>
          {config.liveAvailable
            ? `Restricted to the public fixture · ${Math.round(config.cooldownSeconds / 60)} min cooldown`
            : "Add SOLARI_API_KEY to enable the recorded live run"}
        </p>
        {notice && <div className="inline-notice">{notice}</div>}
      </div>
      <div className={`verdict verdict-${report.status}`}>
        <div>
          <p className="eyebrow">Release verdict</p>
          <strong>{report.verdict}</strong>
        </div>
        <div className="verdict-metrics" aria-label="Check summary">
          <Metric value={report.summary.passed} label="Passed" tone="pass" />
          <Metric value={report.summary.failed} label="Failed" tone="fail" />
          <Metric value={report.summary.warnings} label="Warnings" tone="warn" />
          <Metric value={formatDuration(report.durationMs)} label="Duration" tone="neutral" />
        </div>
      </div>
    </section>
  )
}

function Metric({
  value,
  label,
  tone,
}: {
  value: number | string
  label: string
  tone: "pass" | "fail" | "warn" | "neutral"
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function Pipeline({ stages }: { stages: PipelineStage[] }) {
  return (
    <section className="pipeline-section" aria-labelledby="pipeline-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Execution trace</p>
          <h2 id="pipeline-heading">From untrusted code to recorded proof</h2>
        </div>
        <span className="micro-label">Every remote handle is released</span>
      </div>
      <ol className="pipeline">
        {stages.map((stage, index) => (
          <li key={stage.id} className={`stage stage-${stage.status}`}>
            <div className="stage-index">
              <span>{String(index + 1).padStart(2, "0")}</span>
              <i aria-hidden="true" />
            </div>
            <div className="stage-copy">
              <div>
                <strong>{stage.label}</strong>
                <StageState stage={stage} />
              </div>
              <p>{stage.detail}</p>
              <time>{formatDuration(stage.durationMs)}</time>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function StageState({ stage }: { stage: PipelineStage }) {
  if (stage.status === "active") return <span className="stage-state is-active">Running</span>
  if (stage.status === "passed") return <CheckIcon />
  if (stage.status === "failed") return <CloseIcon />
  return <span className="stage-state">{stage.status}</span>
}

function EvidencePanel({
  report,
  activeSuite,
  activeSuiteId,
  onSuiteChange,
  onReplay,
}: {
  report: RunReport
  activeSuite?: BrowserSuiteReport
  activeSuiteId: BrowserSuiteReport["id"]
  onSuiteChange: (id: BrowserSuiteReport["id"]) => void
  onReplay: () => void
}) {
  return (
    <article className="panel evidence-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Visual evidence</p>
          <h2>What the browser saw</h2>
        </div>
        <div className="suite-tabs" role="tablist" aria-label="Browser viewport">
          {(["desktop", "mobile"] as const).map((id) => {
            const suite = report.suites.find((candidate) => candidate.id === id)
            return (
              <button
                key={id}
                role="tab"
                aria-selected={activeSuiteId === id}
                className={activeSuiteId === id ? "is-active" : ""}
                onClick={() => onSuiteChange(id)}
                disabled={!suite}
              >
                {id === "desktop" ? "1440 / Desktop" : "390 / Mobile"}
              </button>
            )
          })}
        </div>
      </div>
      <div className={`capture-frame capture-${activeSuite?.id ?? "empty"}`}>
        <div className="capture-bar">
          <span className="capture-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>{activeSuite ? `${activeSuite.viewport.width} × ${activeSuite.viewport.height}` : "Awaiting browser"}</span>
          <span>{activeSuite?.replayEventCount ? `${activeSuite.replayEventCount.toLocaleString()} events` : "No replay yet"}</span>
        </div>
        <div className="capture-canvas">
          {activeSuite?.screenshotUrl ? (
            <img src={activeSuite.screenshotUrl} alt={`${activeSuite.label} screenshot evidence`} />
          ) : (
            <div className="empty-capture">
              <SpinnerIcon />
              <p>A recorded browser will appear here.</p>
            </div>
          )}
        </div>
      </div>
      <div className="evidence-footer">
        <div>
          <span className={`status-beacon status-${activeSuite?.status ?? report.status}`} />
          <p>
            <strong>{activeSuite?.label ?? "Browser evidence pending"}</strong>
            <span>{activeSuite ? `${formatDuration(activeSuite.durationMs)} · ${activeSuite.checks.length} checks` : "Waiting for preview"}</span>
          </p>
        </div>
        {activeSuite?.replayUrl ? (
          <button type="button" className="replay-link" onClick={onReplay}>
            Play session replay <PlayIcon />
          </button>
        ) : (
          <span className="replay-link is-muted">
            {report.source === "showcase" ? "Replay summary retained" : "Replay appears after browser release"}
          </span>
        )}
      </div>
    </article>
  )
}

function ChecksPanel({ suite, report }: { suite?: BrowserSuiteReport; report: RunReport }) {
  const grouped = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof suite>["checks"]>()
    for (const check of suite?.checks ?? []) {
      const current = groups.get(check.category) ?? []
      current.push(check)
      groups.set(check.category, current)
    }
    return [...groups.entries()]
  }, [suite])

  return (
    <article className="panel checks-panel">
      <div className="panel-header checks-heading">
        <div>
          <p className="eyebrow">Assertions</p>
          <h2>{suite ? suite.label : "Checks pending"}</h2>
        </div>
        <span className={`result-stamp result-${suite?.status ?? report.status}`}>
          {suite?.status ?? report.status}
        </span>
      </div>
      <div className="check-groups">
        {grouped.length === 0 ? (
          <div className="empty-checks">Checks populate as each recorded journey completes.</div>
        ) : (
          grouped.map(([category, checks]) => (
            <section key={category} className="check-group">
              <h3>{category}</h3>
              {checks.map((check) => (
                <div key={check.id} className={`check-row check-${check.status}`}>
                  <span className="check-icon" aria-hidden="true">
                    {check.status === "passed" ? <CheckIcon /> : check.status === "failed" ? <CloseIcon /> : "!"}
                  </span>
                  <p>
                    <strong>{check.label}</strong>
                    <span>{check.detail}</span>
                  </p>
                  <time>{formatDuration(check.durationMs)}</time>
                </div>
              ))}
            </section>
          ))
        )}
      </div>
      <div className="retention-note">
        <LockIcon />
        <p>
          <strong>{report.environment.snapshotRetained ? "Failure state retained" : "Ephemeral by default"}</strong>
          <span>
            {report.environment.snapshotRetained
              ? "A Solari snapshot can reproduce the exact guest state."
              : "Passing sandboxes are destroyed after evidence collection."}
          </span>
        </p>
      </div>
    </article>
  )
}

function RunLog({ report }: { report: RunReport }) {
  const [open, setOpen] = useState(false)
  const visible = open ? report.logs : report.logs.slice(-4)
  return (
    <section className="run-log" aria-labelledby="log-heading">
      <button className="log-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>
          <TerminalIcon />
          <span>
            <strong id="log-heading">Sanitized run log</strong>
            <small>{report.logs.length} retained lines · credentials never enter the guest</small>
          </span>
        </span>
        <span>{open ? "Collapse" : "Expand all"}</span>
      </button>
      <div className="log-lines">
        {visible.map((entry, index) => (
          <div key={`${entry.at}-${index}`} className={`log-line log-${entry.stream}`}>
            <time>{shortTime(entry.at, true)}</time>
            <span>{entry.stage}</span>
            <code>{entry.message}</code>
          </div>
        ))}
      </div>
    </section>
  )
}

function LoadingScreen() {
  return (
    <div className="state-screen">
      <SpinnerIcon />
      <p>Recovering the latest flight record…</p>
    </div>
  )
}

function ErrorScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="state-screen">
      <CloseIcon />
      <h1>Flight record unavailable</h1>
      <p>The service did not return its evidence index.</p>
      <button onClick={onRetry}>Retry connection</button>
    </div>
  )
}

function targetLabel(report: RunReport): string {
  return `${repositoryName(report.target.repository)} · PR ${report.target.pullNumber ?? "ref"}`
}

function repositoryName(repository: string): string {
  return repository.replace(/\.git$/, "").split("/").slice(-2).join("/")
}

function shortTime(value: string, includeSeconds = false): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
    hour12: false,
  }).format(new Date(value))
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

function formatDuration(value?: number): string {
  if (value === undefined) return "—"
  if (value < 1_000) return `${value}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.2 8.4 3 3.1 6.7-7" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 13 13 3m-6 0h6v6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function LaunchIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 15 15 4m-7 0h7v7" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m5.5 3.5 7 4.5-7 4.5v-9Z" fill="currentColor" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <rect x="3.5" y="7.5" width="11" height="8" rx="1.5" fill="none" stroke="currentColor" />
      <path d="M6 7.5v-2a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="m3 5 3 3-3 3m5 1h6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg className="spinner" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
      <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}
