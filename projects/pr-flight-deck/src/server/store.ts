import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import type { RunReport } from "../shared/model"
import { showcaseReport } from "./showcase"

export class RunStore {
  private readonly reports = new Map<string, RunReport>()
  private readonly dataDirectory?: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(dataDirectory?: string) {
    this.dataDirectory = dataDirectory
    this.reports.set(showcaseReport.id, structuredClone(showcaseReport))
  }

  async initialize(): Promise<void> {
    if (!this.dataDirectory) return
    await mkdir(this.runsDirectory, { recursive: true })
  }

  list(): RunReport[] {
    return [...this.reports.values()]
      .map((report) => structuredClone(report))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  }

  get(id: string): RunReport | undefined {
    const report = this.reports.get(id)
    return report ? structuredClone(report) : undefined
  }

  async put(report: RunReport): Promise<void> {
    await this.serialize(() => this.putUnsafe(report))
  }

  async update(id: string, mutate: (report: RunReport) => void): Promise<RunReport> {
    return this.serialize(async () => {
      const current = this.reports.get(id)
      if (!current) throw new Error(`Unknown run ${id}`)
      const next = structuredClone(current)
      mutate(next)
      await this.putUnsafe(next)
      return structuredClone(next)
    })
  }

  private async putUnsafe(report: RunReport): Promise<void> {
    this.reports.set(report.id, structuredClone(report))
    if (!this.dataDirectory || report.source === "showcase") return
    await mkdir(this.runsDirectory, { recursive: true })
    const destination = path.join(this.runsDirectory, `${report.id}.json`)
    const temporary = `${destination}.tmp`
    await writeFile(temporary, JSON.stringify(report, null, 2), "utf8")
    await rename(temporary, destination)
  }

  async writeArtifact(runId: string, name: string, bytes: Uint8Array): Promise<string> {
    if (!this.dataDirectory) throw new Error("Artifact storage is disabled")
    if (!/^[a-z0-9][a-z0-9._-]{0,120}$/i.test(name)) throw new Error("Invalid artifact name")
    const directory = path.join(this.artifactsDirectory, runId)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, name), bytes)
    return `/artifacts/${runId}/${name}`
  }

  async readArtifact(runId: string, name: string): Promise<Uint8Array> {
    if (!this.dataDirectory) throw new Error("Artifact storage is disabled")
    if (!/^[a-z0-9-]+$/i.test(runId) || !/^[a-z0-9][a-z0-9._-]{0,120}$/i.test(name)) {
      throw new Error("Invalid artifact path")
    }
    return readFile(path.join(this.artifactsDirectory, runId, name))
  }

  get artifactRoot(): string | undefined {
    return this.dataDirectory ? this.artifactsDirectory : undefined
  }

  private get runsDirectory(): string {
    return path.join(this.dataDirectory!, "runs")
  }

  private get artifactsDirectory(): string {
    return path.join(this.dataDirectory!, "artifacts")
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
