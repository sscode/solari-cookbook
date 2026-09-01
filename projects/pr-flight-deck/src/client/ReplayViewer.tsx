import { useEffect, useRef, useState } from "react"
import "rrweb-player/dist/style.css"

import type { BrowserSuiteReport } from "../shared/model"
import { labelReplayPlayer, parseReplayEvents, replaySourceUrl } from "./replay"

type ViewerState = "loading" | "ready" | "error"

export function ReplayViewer({
  runId,
  suite,
  onClose,
}: {
  runId: string
  suite: BrowserSuiteReport
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const playerHostRef = useRef<HTMLDivElement>(null)
  const [viewerState, setViewerState] = useState<ViewerState>("loading")
  const [error, setError] = useState<string>()
  const [loadedEventCount, setLoadedEventCount] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const artifactUrl = replaySourceUrl(suite.replayUrl, runId, suite.id)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const host = playerHostRef.current
    let player: { $destroy?: () => void; pause(): void } | undefined

    setViewerState("loading")
    setError(undefined)
    setLoadedEventCount(0)

    const loadReplay = async () => {
      try {
        const [response, playerModule] = await Promise.all([
          fetch(artifactUrl, {
            headers: { Accept: "application/x-ndjson" },
            signal: controller.signal,
          }),
          import("rrweb-player"),
        ])
        if (!response.ok) throw new Error(`Replay artifact returned HTTP ${response.status}.`)

        const events = parseReplayEvents(await response.text())
        if (controller.signal.aborted || !host) return

        const availableWidth = Math.max(240, host.getBoundingClientRect().width - 2)
        const availableHeight = Math.max(280, window.innerHeight - 270)
        const scale = Math.min(
          1,
          availableWidth / suite.viewport.width,
          availableHeight / suite.viewport.height,
        )
        const minimumWidth = Math.min(280, suite.viewport.width, availableWidth)
        const width = Math.max(minimumWidth, Math.floor(suite.viewport.width * scale))
        const height = Math.max(240, Math.floor(suite.viewport.height * scale))

        player = new playerModule.default({
          target: host,
          props: {
            events,
            width,
            height,
            maxScale: 1,
            autoPlay: false,
            skipInactive: true,
            speedOption: [1, 2, 4, 8],
            showController: true,
          },
        })
        labelReplayPlayer(host, suite.label)
        setLoadedEventCount(events.length)
        setViewerState("ready")
      } catch (caught) {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : "The replay could not be loaded.")
        setViewerState("error")
      }
    }

    void loadReplay()
    return () => {
      controller.abort()
      player?.pause()
      player?.$destroy?.()
      host?.replaceChildren()
    }
  }, [artifactUrl, attempt, suite.viewport.height, suite.viewport.width])

  return (
    <dialog
      ref={dialogRef}
      className="replay-dialog"
      aria-labelledby="replay-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="replay-shell">
        <header className="replay-header">
          <div>
            <p className="eyebrow">Recorded browser session</p>
            <h2 id="replay-title">{suite.label} replay</h2>
            <span>
              {suite.viewport.width} × {suite.viewport.height}
              {loadedEventCount ? ` · ${loadedEventCount.toLocaleString()} rrweb events` : ""}
            </span>
          </div>
          <button type="button" className="replay-close" onClick={onClose} aria-label="Close session replay">
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="m4 4 10 10M14 4 4 14" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </header>

        <div className={`replay-stage replay-stage-${viewerState}`} aria-live="polite">
          <div ref={playerHostRef} className="replay-player-host" />
          {viewerState === "loading" ? (
            <div className="replay-state">
              <span className="replay-loader" aria-hidden="true" />
              <strong>Reconstructing recorded DOM</strong>
              <span>Loading the retained Solari event stream…</span>
            </div>
          ) : null}
          {viewerState === "error" ? (
            <div className="replay-state replay-state-error">
              <strong>Replay unavailable</strong>
              <span>{error}</span>
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                Retry playback
              </button>
            </div>
          ) : null}
        </div>

        <footer className="replay-footer">
          <p>
            <strong>DOM-level proof</strong>
            <span>Controls replay the exact recorded interactions; this is not a video export.</span>
          </p>
          <a href={artifactUrl} download={`${runId}-${suite.id}.ndjson`}>
            Download event data
          </a>
        </footer>
      </div>
    </dialog>
  )
}
