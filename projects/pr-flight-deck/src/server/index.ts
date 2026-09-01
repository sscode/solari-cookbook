import process from "node:process"

import { createServer } from "node:http"

import { attachProductionClient, createApp } from "./app"
import { readEnvironment } from "./config"
import { RunCoordinator } from "./coordinator"
import { SolariFlightEngine } from "./engine"
import { RunStore } from "./store"

const environment = readEnvironment()
const store = new RunStore(environment.dataDirectory)
await store.initialize()

const engine = environment.solariApiKey
  ? new SolariFlightEngine({ apiKey: environment.solariApiKey, store })
  : undefined

const coordinator = new RunCoordinator({
  store,
  engine,
  publicDemo: environment.publicDemo,
  demoRepository: environment.demoRepository,
  demoPullNumber: environment.demoPullNumber,
  cooldownSeconds: environment.demoCooldownSeconds,
})

const app = createApp({ environment, store, coordinator })

if (environment.nodeEnv === "development") {
  const { createServer: createViteServer } = await import("vite")
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" })
  app.use(vite.middlewares)
} else {
  attachProductionClient(app)
}

const server = createServer(app)
server.listen(environment.port, "0.0.0.0", () => {
  console.log(`PR Flight Deck listening on http://0.0.0.0:${environment.port}`)
})

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`${signal} received; draining HTTP connections`)
  server.close((error) => {
    process.exitCode = error ? 1 : 0
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)
