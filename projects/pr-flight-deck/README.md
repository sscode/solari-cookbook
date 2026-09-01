# PR Flight Deck

**[Open the live app](https://pr-flight-deck-production.up.railway.app)** ·
**[Inspect the deterministic demo PR](https://github.com/sscode/solari-cookbook/pull/1)**

PR Flight Deck turns a pull request into recorded release evidence. It checks out
untrusted code inside a disposable [Solari](https://getsolari.com) sandbox,
starts a public preview, drives the critical journey in recorded desktop and
mobile browsers, and returns a compact release verdict with screenshots, an
in-app session player, logs, and a retained failure snapshot.

The hosted app is safe by default: visitors can replay one configured public
fixture PR, but cannot submit arbitrary repositories or spend unbounded Solari
credits. Self-hosted instances can audit any public GitHub pull request or ref.

## Why it is a real Solari use case

Normal CI can tell you that a test failed. Flight Deck preserves the environment
that failed and the browser session that proved it:

```text
public PR
   │
   ▼
Solari sandbox ── checkout / build / preview ── failure snapshot
   │
   ├── recorded browser · 1440 × 900 ── screenshot + rrweb player
   └── recorded browser ·  390 × 844 ── screenshot + rrweb player
   │
   ▼
release verdict + structured evidence
```

Repository code and build tools never execute on the Flight Deck host. Remote
browser and sandbox handles are released in a `finally` path even when checkout,
build, navigation, assertions, replay upload, or snapshotting fails.

## Run locally

Requires Node.js 22+ and a Solari API key.

```bash
cd projects/pr-flight-deck
npm install
cp .env.example .env.local
export SOLARI_API_KEY=slr_live_...
export PUBLIC_DEMO=false
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without a key the app still
loads a retained showcase report, but the live-run button remains disabled.

For the public demo mode, configure a fixed target:

```bash
export PUBLIC_DEMO=true
export DEMO_REPOSITORY=https://github.com/your-handle/solari-cookbook
export DEMO_PULL_NUMBER=1
export DEMO_COOLDOWN_SECONDS=1800
```

## Make a repository auditable

Add `flightdeck.config.json` at the repository root. Commands run with `sh -lc`
inside `projectPath`; paths cannot be absolute or traverse above the checkout.

```json
{
  "version": 1,
  "projectPath": "apps/storefront",
  "installCommand": "npm ci",
  "buildCommand": "npm run build",
  "startCommand": "npm start -- --host 0.0.0.0 --port 4173",
  "port": 4173,
  "healthPath": "/",
  "journeys": [
    {
      "id": "checkout",
      "name": "Checkout",
      "steps": [
        { "action": "goto", "path": "/" },
        { "action": "click", "role": "button", "name": "Buy now" },
        {
          "action": "expectText",
          "text": "Order confirmed",
          "checkLabel": "Checkout confirms the order"
        }
      ]
    }
  ]
}
```

Supported journey actions are `goto`, `click`, `fill`, `press`, `expectText`,
`expectVisible`, and `expectUrlContains`. Add an optional `checkLabel` to give any
step a release-focused name. Flight Deck also checks HTTP status,
document title, browser exceptions, mobile overflow, accessible control names,
form labels, image alternatives, unique IDs, and the main landmark.

## API

- `GET /api/health` — deployment health
- `GET /api/config` — public mode and fixed demo target
- `GET /api/runs` — retained and current reports
- `GET /api/runs/:id` — one report while it progresses
- `POST /api/runs` — `{ "demo": true }` in hosted mode, or a validated public
  GitHub repository plus `pullNumber`/`ref` when self-hosted

## Verify and deploy

```bash
npm run check
railway up
```

Set `SOLARI_API_KEY`, `PUBLIC_DEMO`, `DEMO_REPOSITORY`, `DEMO_PULL_NUMBER`, and
`FLIGHT_DECK_REPOSITORY_URL` in Railway. `.railway/railway.ts` configures the
build, start command, health check, and preserved server-side variables.

## Security and operating limits

- Only HTTPS repositories under `github.com/<owner>/<repo>` are accepted.
- Git refs reject option injection and parent traversal.
- Project paths are constrained to the remote checkout.
- Request bodies are capped at 16 KiB and validated with Zod.
- The public deployment only runs one configured PR, one run at a time, with a
  configurable cooldown.
- The Solari API key stays server-side and is never passed into the sandbox.
- Solari preview capability tokens stay in server-side request headers and are
  never written into report URLs or run logs.
- The guest clock is synchronized before checkout so HTTPS verification stays
  enabled even when a restored sandbox snapshot has stale time.
- Artifacts use generated run IDs and allow-listed filenames.

This is a competition project in the Solari Cookbook, not an official Solari
product.
