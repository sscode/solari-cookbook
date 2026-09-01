import { describe, expect, it } from "vitest"

import { FlightDeckProjectConfigSchema, GithubRepositorySchema, RunRequestSchema } from "./schema"

describe("FlightDeckProjectConfigSchema", () => {
  const valid = {
    version: 1,
    projectPath: "apps/storefront",
    startCommand: "npm start",
    port: 4173,
    journeys: [{ id: "smoke", name: "Smoke", steps: [{ action: "goto", path: "/" }] }],
  }

  it("normalizes a valid project configuration", () => {
    expect(FlightDeckProjectConfigSchema.parse(valid).healthPath).toBe("/")
  })

  it.each(["../private", "apps/../../private", "/etc"])("rejects unsafe project path %s", (projectPath) => {
    expect(() => FlightDeckProjectConfigSchema.parse({ ...valid, projectPath })).toThrow()
  })
})

describe("public input schemas", () => {
  it("accepts only simple public GitHub repository URLs", () => {
    expect(GithubRepositorySchema.parse("https://github.com/acme/rocket.git")).toBe(
      "https://github.com/acme/rocket",
    )
    expect(() => GithubRepositorySchema.parse("https://user:secret@github.com/acme/rocket")).toThrow()
    expect(() => GithubRepositorySchema.parse("https://gitlab.com/acme/rocket")).toThrow()
  })

  it("rejects ref option injection and traversal", () => {
    expect(() =>
      RunRequestSchema.parse({
        demo: false,
        repository: "https://github.com/acme/rocket",
        ref: "--upload-pack=oops",
      }),
    ).toThrow()
    expect(() =>
      RunRequestSchema.parse({
        demo: false,
        repository: "https://github.com/acme/rocket",
        ref: "feature/../main",
      }),
    ).toThrow()
  })
})
