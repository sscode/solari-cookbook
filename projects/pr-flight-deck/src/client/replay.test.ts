// @vitest-environment jsdom

import { describe, expect, it } from "vitest"

import { labelReplayPlayer, parseReplayEvents, replayArtifactUrl, replaySourceUrl } from "./replay"

const meta = { type: 4, data: { href: "https://example.com", width: 1440, height: 900 }, timestamp: 10 }
const snapshot = { type: 2, data: { node: { type: 0, childNodes: [], id: 1 } }, timestamp: 11 }

describe("parseReplayEvents", () => {
  it("parses Solari's newline-delimited rrweb event stream", () => {
    const events = parseReplayEvents(`${JSON.stringify(meta)}\r\n${JSON.stringify(snapshot)}\n\n`)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject(meta)
    expect(events[1]).toMatchObject(snapshot)
  })

  it("identifies malformed event lines", () => {
    expect(() => parseReplayEvents(`${JSON.stringify(meta)}\nnot-json`)).toThrow(
      "Replay event 2 is not valid JSON.",
    )
  })

  it("requires the metadata and full snapshot needed by rrweb", () => {
    const incremental = { type: 3, data: { source: 1 }, timestamp: 12 }

    expect(() => parseReplayEvents(`${JSON.stringify(snapshot)}\n${JSON.stringify(incremental)}`)).toThrow(
      "viewport metadata",
    )
    expect(() => parseReplayEvents(`${JSON.stringify(meta)}\n${JSON.stringify(incremental)}`)).toThrow(
      "full DOM snapshot",
    )
  })
})

describe("replayArtifactUrl", () => {
  it("targets the retained same-origin artifact", () => {
    expect(replayArtifactUrl("run id", "mobile")).toBe("/artifacts/run%20id/mobile.ndjson")
  })

  it("uses retained same-origin URLs and replaces legacy signed URLs", () => {
    expect(replaySourceUrl("/showcase/desktop.ndjson", "run-1", "desktop")).toBe(
      "/showcase/desktop.ndjson",
    )
    expect(replaySourceUrl("https://storage.example/replay.gz", "run-1", "desktop")).toBe(
      "/artifacts/run-1/desktop.ndjson",
    )
  })
})

describe("labelReplayPlayer", () => {
  it("gives rrweb's icon-only controls and iframe accessible names", () => {
    const host = document.createElement("div")
    host.innerHTML = `
      <iframe></iframe>
      <button><svg></svg></button>
      <button>1x</button>
      <input type="checkbox">
      <button><svg></svg></button>
    `

    labelReplayPlayer(host, "Desktop Chrome")

    expect(host.querySelector("iframe")?.getAttribute("title")).toBe("Desktop Chrome recorded page")
    expect(host.querySelector("input")?.getAttribute("aria-label")).toBe("Skip inactive periods")
    expect(host.querySelectorAll("button")[0]?.getAttribute("aria-label")).toBe("Play or pause replay")
    expect(host.querySelectorAll("button")[2]?.getAttribute("aria-label")).toBe(
      "Toggle replay fullscreen",
    )
  })
})
