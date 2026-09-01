type RrwebPlayerConstructor = (typeof import("rrweb-player"))["default"]

export type ReplayEvents = ConstructorParameters<RrwebPlayerConstructor>[0]["props"]["events"]

export function replayArtifactUrl(runId: string, suiteId: "desktop" | "mobile"): string {
  return `/artifacts/${encodeURIComponent(runId)}/${suiteId}.ndjson`
}

export function replaySourceUrl(
  replayUrl: string | undefined,
  runId: string,
  suiteId: "desktop" | "mobile",
): string {
  return replayUrl?.startsWith("/") ? replayUrl : replayArtifactUrl(runId, suiteId)
}

export function parseReplayEvents(source: string): ReplayEvents {
  const lines = source.split(/\r?\n/).filter((line) => line.trim())
  const events: unknown[] = []

  for (const [index, line] of lines.entries()) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error(`Replay event ${index + 1} is not valid JSON.`)
    }

    if (!isReplayEvent(event)) {
      throw new Error(`Replay event ${index + 1} is missing its type, timestamp, or data.`)
    }
    events.push(event)
  }

  if (events.length < 2) throw new Error("The replay does not contain enough events to play.")
  if (!events.some((event) => isReplayEvent(event) && event.type === 4)) {
    throw new Error("The replay is missing its viewport metadata.")
  }
  if (!events.some((event) => isReplayEvent(event) && event.type === 2)) {
    throw new Error("The replay is missing its full DOM snapshot.")
  }

  return events as ReplayEvents
}

export function labelReplayPlayer(host: HTMLElement, suiteLabel: string): void {
  host.querySelector("iframe")?.setAttribute("title", `${suiteLabel} recorded page`)
  host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.setAttribute(
    "aria-label",
    "Skip inactive periods",
  )

  const iconButtons = [...host.querySelectorAll("button")].filter(
    (button) => !button.textContent?.trim() && !button.getAttribute("aria-label"),
  )
  iconButtons[0]?.setAttribute("aria-label", "Play or pause replay")
  if (iconButtons.length > 1) iconButtons.at(-1)?.setAttribute("aria-label", "Toggle replay fullscreen")
}

function isReplayEvent(value: unknown): value is { type: number; timestamp: number; data: unknown } {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    Number.isInteger(candidate.type) &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp) &&
    "data" in candidate
  )
}
