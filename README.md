# Synthetic User Swarm

Launch 10–100 LLM-driven personas at a live website in parallel. Each persona tries to finish a real task the
way that kind of person would; the swarm turns where they struggle into a ranked list of usability issues, each
linked to the screenshots, steps and think-aloud quotes that prove it.

**Core rule: no evidence, no issue.** The critic may propose a problem, but it reaches the report only if it cites
recorded steps that exist, names an element seen in those steps, and has a deterministic signal or a verbatim
quote behind it (`swarm/analysis/validator.py`).

Built with **Python 3.12+ and FastAPI**: Playwright (async) drives the browsers, Pydantic validates every schema, the
dashboard is served by the same FastAPI app.

The design follows `docs/Synthetic User Swarm — System Architecture.pdf`.

## Quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"                    # or: pip install -r requirements-dev.txt
python -m playwright install chromium
echo 'OPENROUTER_API_KEY="sk-or-..."' > .env   # loaded automatically; or SWARM_MODEL_MODE=mock to run offline

swarm shop                                 # demo shop with 14 seeded defects on :4400
swarm credits                              # OpenRouter credit left on the key
swarm estimate studies/demo-shop-smoke.yaml   # expected and worst-case cost
swarm run studies/demo-shop-smoke.yaml        # 3 personas × 1 task, ≈ $0.02, prints a report path
swarm serve                                # live dashboard on http://localhost:4300 (API docs at /api/docs)
pytest                                     # unit, end-to-end (mock mode) and hosted-mode tests
```

`swarm` is also `python -m swarm`.

Models run through [OpenRouter](https://openrouter.ai). Every role defaults to `anthropic/claude-haiku-5.5`
($0.10 / $0.50 per million tokens): on the demo shop a step costs about $0.0003 and a session about $0.005–0.01.

Requires Python 3.12+. No database, Redis or object store to set up: everything lives under `data/` (SQLite and
content-addressed files; override with `SWARM_DATA_DIR`).

## Dashboard

`swarm serve`, then open http://localhost:4300. Press <kbd>⌘K</kbd> (or <kbd>/</kbd>) to jump to any study, issue or page.

- **Studies**: totals across studies and one row per study with progress, task success, issues by severity and spend.
- **New study**: a four-step wizard (Site → Tasks → Personas → Budget) with domain discovery, a live cost
  estimate against your remaining OpenRouter credit, and the generated study YAML.
- **Study workspace**: Overview (task success, issues, drop-off funnels, task × persona matrix), Live (agent wall,
  issue feed, journey map, activity), Issues (filterable list, evidence screenshots with the tapped element boxed,
  attributed quotes, replays, export to GitHub/Jira/Linear) and Sessions (every run, with a step-by-step drawer).
- **Report tab**: the shareable HTML report embedded, with JSON and PDF downloads.
- **Compare runs**: pick a baseline and a later run; issues are labelled new, fixed, regressed or unchanged.
- **Personas**: the curated library and the mechanisms that enforce each trait.
- **Settings**: models and effort, credit and reserve, integrations, access and safety (read from `.env`).

Every screenshot opens in a lightbox with the tapped element boxed; "Watch it happen" opens the session replay in-app
at that exact step.

Studies launched from the CLI appear and stream live in the dashboard too (both read the same `data/` store).

## CLI

| Command | What it does |
| --- | --- |
| `swarm run <study.yaml> [--no-merge] [--pdf]` | Plan and run a study, analyse it, write the report |
| `swarm plan <study.yaml>` | Expand a study into persona × task × repetition sessions |
| `swarm resume <studyId>` | Continue after a crash; recorded steps are kept and sessions resume from their last step |
| `swarm analyse <studyId>` | Re-run signals, critic and synthesis over recorded evidence |
| `swarm report <studyId> [--compare <id>] [--pdf]` | HTML + JSON (+ PDF) report, optionally with a run diff |
| `swarm diff <base> <head>` | Label issues new / fixed / regressed / unchanged |
| `swarm ci <studyId> --baseline <id> [--min-severity 3]` | Exit 1 when a new or regressed issue at or above the severity appears |
| `swarm bench <studyId> [--defects D04,D14] [--method llm\|keyword]` | Recall and precision against the demo shop's seeded defects (judge model by default) |
| `swarm export <issueId> --to github\|jira\|linear [--dry-run]` | File the issue with its evidence links |
| `swarm personas [--generate "<segment>" --count N]` | List curated personas or generate new ones |
| `swarm credits` | OpenRouter credit left on the key |
| `swarm domains <url>` | Hosts a site contacts, to fill `allowed_domains` |
| `swarm estimate <study.yaml>` | Expected and worst-case cost before running |
| `swarm serve [--port 4300]` | Dashboard + API (FastAPI; OpenAPI docs at `/api/docs`) |
| `swarm shop` | The demo shop (`PORT`, `DEFECTS=all\|none\|D01,D04`) |

Run it as `swarm <command>` or `python -m swarm <command>`.

## A study file

```yaml
name: Kindling & Co. — gift purchase
target_url: http://localhost:4400/
allowed_domains: [localhost]
permission_confirmed: true          # only test sites you own or have written permission to test
reset_url: http://localhost:4400/__reset   # optional: reset site state before each session
tasks:
  - id: buy-gift
    goal: Buy a birthday present for a friend that costs less than $40, and have it delivered to your home.
    success:                        # checked in code, never taken on the agent's word
      mode: any
      url_pattern: "/order/KC\\d+"
      network: { method: POST, url_pattern: "/api/orders", status: 201 }
      # llm_judge: "The order confirmation page is showing"   # for fuzzy goals
    # auth:  [{ goto: ..., fill: { selector: "#password", secret: SHOP_PASSWORD }, click: "button" }]
    # setup: [{ goto: ".../products/2" }, { click: "#add", wait_ms: 800 }]   # start the task from a given state
personas:
  include: [asha-68-mobile, sam-screen-reader]   # empty = all curated personas
  generate: [{ segment: "Indian small-business owners, 30–55, mostly Android", count: 4 }]
  seeded_from: benchmark/analytics-sample.json
  size: 12
  mobile_share: 0.7
budget: { repetitions: 3, max_steps: 30, wall_clock_minutes: 10, cost_cap_usd: 15, concurrency: 6 }
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | OpenRouter key (read from `.env`) |
| `SWARM_MODEL_MODE` | `live` if a key is set, else `mock` | `mock` = deterministic offline policy and rule-based critic |
| `SWARM_STEP_MODEL` | `anthropic/claude-haiku-5.5` | Any OpenRouter vision model with structured outputs |
| `SWARM_ESCALATION_MODEL` | same as step | Used for 3 steps when the agent is stuck |
| `SWARM_CRITIC_MODEL` / `SWARM_SYNTHESIS_MODEL` / `SWARM_JUDGE_MODEL` | `anthropic/claude-haiku-5.5` | Per-session critic, cluster merge, fuzzy success judge |
| `SWARM_STEP_EFFORT` / `SWARM_ESCALATION_EFFORT` / `SWARM_CRITIC_EFFORT` | `low` / `high` / `medium` | Reasoning effort; escalation means thinking harder, not a pricier model |
| `SWARM_CREDIT_RESERVE_USD` | `0.5` | Never spend below this; every study is capped at the credit left above it |
| `SWARM_IMAGE_MAX_WIDTH` | `1024` | Screenshots sent to the model are downscaled to this width |
| `SWARM_BENCHMARK_MODEL` | `anthropic/claude-sonnet-5.5` | Judge for the seeded-defect benchmark (rare, ~$0.01 a scoring) |
| `SWARM_PASSWORD` | — | Admin password login (with Google sign-in, an extra admin login) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Enables hosted multi-user mode with Sign in with Google |
| `SWARM_SECRET` | — | Signs sessions and encrypts stored API keys (required with Google sign-in) |
| `DATABASE_URL` | — | Postgres for accounts, limits and keys (SQLite if unset) |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | Public origin for the OAuth redirect |
| `SWARM_HOST` | `127.0.0.1` | Bind address |
| `SWARM_DATA_DIR` | `./data` | Evidence store, reports |
| `SWARM_PORT` | `4300` | Dashboard |
| `SWARM_PER_DOMAIN_CONCURRENCY` | `8` | Politeness cap per target domain |
| `SWARM_HEADFUL=1` | — | Show the browsers |
| `GITHUB_REPO`, `GITHUB_TOKEN` · `LINEAR_API_KEY`, `LINEAR_TEAM_ID` · `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` | — | Issue export |

## Layout

```
swarm/
  models.py             Pydantic schemas for personas, studies, agent I/O and issues
  config.py             settings from the environment (.env is loaded)
  orchestrator.py       plan, schedule, budgets, retries, resume, one runner per study
  personas/             curated loader, profiles (trait -> mechanism), generator, sampler
  runtime/              sandbox, perception (Set-of-Marks), actions, checks, agent loop, robots, SSRF guard
  llm/                  OpenRouter client (strict JSON schema, exact cost), prompts, offline mock policy
  analysis/             signals, critic, validator, embeddings, clustering, synthesis, severity
  report/               report data, HTML, run diff, benchmark, integrations
  server/               FastAPI app: API, SSE, auth (Google OIDC), static dashboard
  store/                SQLite rows, accounts (SQLite or Postgres), content-addressed blobs, event bus
  web/                  the dashboard (vanilla ES modules, no build step)
  vendor/               rrweb, rrweb-player and axe-core browser bundles (see vendor/README.md)
  cli.py                the `swarm` command
demo_shop/              seeded-defect test site (FastAPI; 14 defects, switchable at /__defects)
personas/               12 curated persona cards
studies/                example studies
tests/                  pytest: unit, end-to-end (mock mode) and hosted-mode API tests
```

## Testing your own app

1. Use a site you own or may test, ideally staging. Run `swarm domains <url>` and keep the hosts the app needs
   (its domain, API, CDN, login); anything not allowed is blocked and can break the page.
2. Write 1–5 tasks in the user's words, each with a success rule the code can check (URL pattern, text, or API call).
3. For logins, add scripted `auth` steps that read secrets from `.env` (`fill: { selector, secret: ENV_VAR_NAME }`).
4. `swarm estimate study.yaml`, then launch from the dashboard (New study) or `swarm run study.yaml`.
5. After a fix, rerun with `compare_to: <previous study id>` to see issues marked fixed / new / regressed.

Without a login configured the dashboard has no sign-in, so keep it on your machine (it binds to localhost by default). For CI, copy
`ci/github-actions-swarm.yml`: it runs a study on each staging deploy and fails on new severity-3+ issues.

## Hosted mode: Google sign-in, one free run, bring your own key

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and the dashboard becomes multi-user:

- People sign in with Google (OpenID Connect, PKCE; the ID token's signature is verified against Google's keys).
- Each person sees only their own studies, screenshots, replays and reports.
- Every account gets `SWARM_FREE_RUNS` (default 1) small runs on the platform key: up to `SWARM_FREE_MAX_SESSIONS`
  sessions (6), `SWARM_FREE_MAX_STEPS` steps (20) and `SWARM_FREE_COST_CAP_USD` ($0.10). All free runs together
  stop at `SWARM_PLATFORM_DAILY_CAP_USD` ($0.50) per UTC day.
- After that, people add their own OpenRouter key in Settings. It is checked with OpenRouter, encrypted with
  AES-256-GCM (key derived from `SWARM_SECRET`) and used only for their runs.
- `SWARM_ADMIN_EMAILS` (comma-separated) marks admins: platform key, no limits, see everything.
- Accounts live in Postgres when `DATABASE_URL` is set (needed on hosts with ephemeral disks), else SQLite.
- Safety: every URL a study names must be public http(s), and every browser request is checked again, so studies
  cannot reach the server, private networks or cloud metadata. `SWARM_DEMO_SHOP=1` runs the demo shop inside the
  container and allows exactly that address.

Google Cloud Console → APIs & Services → Credentials → OAuth client (Web application). Authorised redirect URIs:
`https://<your-host>/auth/google/callback` and, for local testing, `http://localhost:4300/auth/google/callback`.

## Deploying to Render (free)

`render.yaml` is a Blueprint: on Render choose New → Blueprint, pick the repo, and fill in `OPENROUTER_API_KEY`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL` (e.g. Neon's free Postgres) and `SWARM_ADMIN_EMAILS`.
`SWARM_SECRET` is generated. The free plan has 512 MB of RAM (one browser at a time), sleeps after 15 minutes idle,
and wipes its disk on restart: studies are temporary there, while accounts and limits persist in Postgres.

## Deploying to a Google Cloud VM

`deploy/gcp/` runs the dashboard on one e2-medium VM (2 vCPUs, 4 GB RAM + 4 GB swap) behind Caddy, which gets a
Let's Encrypt certificate for a free `<ip-with-dashes>.sslip.io` hostname. Studies and accounts stay on the VM's disk.

```bash
gcloud auth login && gcloud config set project <project-id>
deploy/gcp/setup.sh            # static IP, firewall rule for 80/443, VM with Docker; prints the https URL
# put the settings in /opt/swarm/.env on the VM: SWARM_DOMAIN, OPENROUTER_API_KEY, SWARM_SECRET, SWARM_PASSWORD,
# GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SWARM_ADMIN_EMAILS, SWARM_DEMO_SHOP=1
deploy/gcp/deploy.sh           # ships the last commit and rebuilds; run it again after each change
```

The Google OAuth redirect URI is `https://<ip-with-dashes>.sslip.io/auth/google/callback`.

## Running it on a server (Docker)

```bash
echo 'SWARM_PASSWORD="choose-a-long-password"' >> .env   # required off localhost
docker compose up --build    # dashboard on 127.0.0.1:4300, demo shop on 127.0.0.1:4400
```

With `SWARM_PASSWORD` set, every page, API call and evidence file needs a sign-in (or `Authorization: Bearer <password>`
for scripts). The server refuses to listen on anything but localhost without it. Inside compose, test the demo shop with
`studies/demo-shop.compose.yaml` (`http://shop:4400`). Put a TLS reverse proxy in front before sharing the dashboard.

## Keeping OpenRouter spend low

- One cheap model for every role; set `SWARM_CRITIC_MODEL=anthropic/claude-sonnet-5.5` only if critic quality
  needs it (about 20× the price).
- `swarm estimate` before a run; the study's `cost_cap_usd` is clamped to the credit left on the key minus the reserve.
- The exact cost of every call comes from OpenRouter's usage report and is shown per step, session and study.
- Screenshots are downscaled, and none is sent when the page hasn't changed since the last step.
- The persona prompt is marked cacheable; once the cap is reached the critic falls back to the free rule-based one.

## Safety

- A study must set `permission_confirmed: true`; the browser's egress is restricted to `allowed_domains`.
- The target's robots.txt is honoured by default (`respect_robots: true`): disallowed page loads are blocked and in-app
  navigation into them is undone.
- The user agent identifies the swarm; 429/5xx responses back off, and repeated failures become `infra_error`, never findings.
- Logins run as scripted steps with secrets from environment variables; the model never sees a password.
- Inputs are masked in rrweb, sensitive fields are masked in screenshots, emails/phones/cards are scrubbed from logs.
- Page content is data, never instructions; the action space has no way to send data elsewhere. "Place order"-style
  actions are blocked when a task sets `allow_irreversible: false`.
