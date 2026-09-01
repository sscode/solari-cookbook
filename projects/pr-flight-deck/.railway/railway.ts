import { defineRailway, preserve, project, service } from "railway/iac"

export default defineRailway(() => {
  const app = service("pr-flight-deck", {
    build: "npm run build",
    start: "npm start",
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    env: {
      SOLARI_API_KEY: preserve(),
      PUBLIC_DEMO: "true",
      DEMO_REPOSITORY: "https://github.com/sscode/solari-cookbook",
      DEMO_PULL_NUMBER: "1",
      DEMO_COOLDOWN_SECONDS: "1800",
      FLIGHT_DECK_REPOSITORY_URL: "https://github.com/sscode/solari-cookbook",
      NODE_ENV: "production",
    },
  })

  return project("pr-flight-deck", {
    resources: [app],
  })
})
