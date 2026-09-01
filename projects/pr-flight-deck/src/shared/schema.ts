import { z } from "zod"

const safeRelativePath = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !value.startsWith("/"), "must be relative")
  .refine(
    (value) => !value.split("/").some((segment) => segment === ".."),
    "must not traverse parent directories",
  )

const shellCommand = z.string().trim().min(1).max(1_000)

const gotoStep = z.object({
  action: z.literal("goto"),
  path: z.string().startsWith("/").max(240),
})

const clickStep = z.object({
  action: z.literal("click"),
  role: z.enum(["button", "link"]),
  name: z.string().min(1).max(160),
  exact: z.boolean().optional(),
})

const fillStep = z.object({
  action: z.literal("fill"),
  label: z.string().min(1).max(160),
  value: z.string().max(1_000),
})

const pressStep = z.object({
  action: z.literal("press"),
  key: z.string().min(1).max(40),
})

const expectTextStep = z.object({
  action: z.literal("expectText"),
  text: z.string().min(1).max(240),
  exact: z.boolean().optional(),
})

const expectVisibleStep = z.object({
  action: z.literal("expectVisible"),
  selector: z.string().min(1).max(240),
})

const expectUrlStep = z.object({
  action: z.literal("expectUrlContains"),
  value: z.string().min(1).max(240),
})

export const JourneyStepSchema = z.discriminatedUnion("action", [
  gotoStep,
  clickStep,
  fillStep,
  pressStep,
  expectTextStep,
  expectVisibleStep,
  expectUrlStep,
])

export const FlightDeckProjectConfigSchema = z.object({
  version: z.literal(1),
  projectPath: safeRelativePath,
  installCommand: shellCommand.optional(),
  buildCommand: shellCommand.optional(),
  startCommand: shellCommand,
  port: z.number().int().min(1_024).max(65_535),
  healthPath: z.string().startsWith("/").max(240).default("/"),
  journeys: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        name: z.string().min(1).max(120),
        steps: z.array(JourneyStepSchema).min(1).max(30),
      }),
    )
    .min(1)
    .max(10),
})

export const GithubRepositorySchema = z
  .string()
  .url()
  .max(300)
  .transform((value) => value.replace(/\.git$/, ""))
  .refine((value) => {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.username === "" &&
      url.password === "" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)
    )
  }, "must be a public GitHub repository URL")

export const CustomRunRequestSchema = z.object({
  demo: z.literal(false),
  repository: GithubRepositorySchema,
  pullNumber: z.number().int().positive().max(10_000_000).optional(),
  ref: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
    .refine((value) => !value.includes("..") && !value.startsWith("-"))
    .optional(),
})

export const DemoRunRequestSchema = z.object({
  demo: z.literal(true),
})

export const RunRequestSchema = z.discriminatedUnion("demo", [
  DemoRunRequestSchema,
  CustomRunRequestSchema,
])

export type RunRequest = z.infer<typeof RunRequestSchema>
