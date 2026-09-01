import path from "node:path"

import { z } from "zod"

import { GithubRepositorySchema } from "../shared/schema"

const optionalRepository = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  GithubRepositorySchema.optional(),
)

const optionalPositiveInteger = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? Number(value) : undefined),
  z.number().int().positive().optional(),
)

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65_535).default(3_000),
  PUBLIC_DEMO: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  SOLARI_API_KEY: z.string().min(12).optional(),
  DEMO_REPOSITORY: optionalRepository,
  DEMO_PULL_NUMBER: optionalPositiveInteger,
  DEMO_COOLDOWN_SECONDS: z.coerce.number().int().min(30).max(86_400).default(1_800),
  FLIGHT_DECK_DATA_DIR: z.string().min(1).default(".flightdeck"),
  FLIGHT_DECK_REPOSITORY_URL: z
    .string()
    .url()
    .default("https://github.com/sscode/solari-cookbook"),
})

export interface AppEnvironment {
  nodeEnv: "development" | "test" | "production"
  port: number
  publicDemo: boolean
  solariApiKey?: string
  demoRepository?: string
  demoPullNumber?: number
  demoCooldownSeconds: number
  dataDirectory: string
  repositoryUrl: string
}

export function readEnvironment(source: NodeJS.ProcessEnv = process.env): AppEnvironment {
  const value = EnvironmentSchema.parse(source)
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    publicDemo: value.PUBLIC_DEMO,
    solariApiKey: value.SOLARI_API_KEY,
    demoRepository: value.DEMO_REPOSITORY,
    demoPullNumber: value.DEMO_PULL_NUMBER,
    demoCooldownSeconds: value.DEMO_COOLDOWN_SECONDS,
    dataDirectory: path.resolve(value.FLIGHT_DECK_DATA_DIR),
    repositoryUrl: value.FLIGHT_DECK_REPOSITORY_URL,
  }
}
