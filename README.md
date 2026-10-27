<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-dark.png"/>
    <img src="logo.png" alt="Bedbricks" width="340"/>
  </picture>
  <br/>
  <em>Manage your Databricks jobs from your phone. 🛏</em>
</p>

<p align="center">
  A mobile-first Google Apps Script web app for Databricks —<br/>
  dashboard, run history, AI-powered diagnostics, and notebook fixes,<br/>
  without ever opening Databricks.
</p>

<p align="center">
  <b>No server. No infra.</b> Just a Web App URL you open on your phone.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-v90-FF3621?style=flat-square"/>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Google%20Apps%20Script-4285F4?style=flat-square&logo=google"/>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-22C55E?style=flat-square"/>
</p>

<p align="center">
  <img src="docs/bedbricks-demo.gif" width="320" alt="Bedbricks — failed job → AI diagnosis → fix → repair, from your phone"/>
</p>

---

## Screenshots

📸 **[Full screenshot gallery → docs/SCREENSHOTS.md](docs/SCREENSHOTS.md)** — dashboard, AI diagnosis & fix, connection setup, and the optional AI hint.

---

## Guides

📄 **Setup & user guide** — [English](docs/install-guide.pdf) · [Español](docs/install-guide-es.pdf) — how to access, install on iOS/Android, and a full feature tour. Share it with your team.

---

## Features

### v1 — Core control
1. Job dashboard with status dots (last 5 runs per job)
2. Global run history (Runs tab)
3. Job detail: expandable task list (SUCCESS) or AI diagnosis + Repair (FAILED)
4. Trigger any job (▶ Run Now) and repair failed tasks without opening Databricks
5. **Think Fix** — an LLM inspects real table schemas from Hive Metastore via the Clusters Execute Command API and proposes a concrete find → replace patch for your notebook. Optional **hint field**: before diagnosing you can type a free-text suggestion (e.g. "the table was renamed to X") that the LLM weighs heavily — leave it empty for a fully automatic diagnosis
6. Multi-task failures, sub-jobs, and chained repairs (`latest_repair_id` auto-detected)

### v2 — Dashboard
7. **Pinned job widget** — fixed card above the job list: status badge + progress bar + elapsed time. Tap → detail view.
8. **Auto-refresh 30s** — activates when a job is RUNNING. Countdown in the header. Stops automatically.
9. **Quick filters** — `All` · `Failed` · `Running` chips. Client-side, combined with text search.
10. **Favorites ★** — toggle on any job row. Favorites float to the top. Persisted cross-device via `UserProperties`.
11. **Cancel run** — `✕ Cancel` button when a job is RUNNING. Confirm dialog + auto-refresh.
12. **Run history** — last 10 runs per job in the detail view (date, duration, status).
13. **Fixes tab** — log of all applied patches: notebook path, timestamp, find → replace preview. Max 50, FIFO.
14. **Dark/light mode** — SVG toggle, persisted in `localStorage`.

### v3 — Multi-user
15. **Per-user config** — host, token, LLM endpoint, and pinned job stored per-user in `UserProperties`. Credentials never shared via `ScriptProperties`.
16. **Setup wizard** — first-run full-screen modal. App blocks until host + token are configured.
17. **Pin Job (📌)** — pin any job as the featured widget. Toggle from the job row or the Settings tab.
18. **Settings tab (⚙)** — edit connection, choose LLM endpoint from a live dropdown, manage pinned job.
19. **Configurable LLM endpoint** — populated dynamically from `/api/2.0/serving-endpoints` (READY only).
20. **Marquee for long names** — job names that overflow scroll horizontally.

### v4 — i18n + New features
21. **Language toggle EN/ES** — full bilingual UI in Settings tab, persisted per-user in `UserProperties`. LLM prompts in `pensarFix` also switch language.
22. **Diff visual before applying fix** — unified diff (LCS line-by-line) replaces the two separate `<pre>` blocks. Lines removed in red (−), lines added in green (+).
23. **Tab Clusters** — live list of all workspace clusters with state badges (Running/Terminated/Starting/Error). Start and Terminate buttons without leaving the app.
24. **Scheduler one-shot** — schedule any job to run at a specific date/time. Uses GAS time-based triggers (`ScriptApp.newTrigger`). Pending scheduled runs visible and cancellable from Settings.
25. **Performance chart** — SVG bar chart of the last 10 run durations (colored by state) with fail-rate badge, shown in every job detail view.
26. **Task DAG** — visual dependency graph rendered as SVG in the job detail view. Nodes colored by state (green/red/blue), cubic Bézier edges, horizontal column layout by depth.

### v6 — Power features
27. **Drill into failed sub-jobs** — when a failed task is a `run_job` (sub-job), the detail view shows an **"open child job →"** button that navigates straight to the child run (where the real notebook failure + Think Fix live). Backend resolves `subjob_id` + `subjob_name`.
28. **Repair continues the DAG** — `repairRun` now sends a flat `rerun_tasks` array (fixed a `[["task"]]` nesting bug → 400) plus `rerun_dependent_tasks: true`, so repairing a failed task also re-runs the downstream tasks it had blocked. `latest_repair_id` persisted per-run in `UserProperties` (the API never returns `repair_history`).
29. **Parameter editor** — ⚙ button in the detail header opens a modal of editable key-value rows (pre-filled from the job's default `base_parameters`). Triggers the job with `notebook_params` override via `triggerJob(jobId, params)`.
30. **Global search** — magnifier in the header opens a full-screen overlay that searches job names, job IDs, run IDs and run job names across loaded data. Tap a result to jump to its detail.
31. **Run comparison** — collapsible picker of two runs of the same job in the detail view. Side-by-side table of per-task duration with a signed delta in seconds (green faster / red slower). Backend adds per-task `duration_ms` to `run_history_with_tasks`.

### v7 — Multi-workspace
32. **Multiple workspaces** — save several Databricks workspaces (name + host + token) and switch the active one from **Settings → Workspaces**. The whole app (jobs, runs, clusters, fixes) reloads for the active workspace. Each workspace keeps its own token, LLM endpoint and pinned job; language is global. Config migrates automatically from the old single-workspace shape. All per-user in `UserProperties` — no shared credentials, no backend.
33. **Universal icon UI + spinners** — loading states render an animated spinner; primary actions are compact icons (`▶` run, `✓` apply, `✕` cancel, `‹` back, `🔧 Repair`, `💡 Think Fix`) with localized tooltips (`data-i18n-title`). Fully bilingual EN/ES including the AI diagnosis and the Task Code Viewer (previously hard-coded). Expandable **Fixes** entries with full red/green diffs.

### v8 — Large jobs & sentinel tasks
34. **Paginated run detail** — `runs/get` returns at most 100 tasks per page. Every run read (`getJobDetail`, `_fetchRunsWithTasks`, `getOrchestratorStatus`) now follows `next_page_token`, so jobs with hundreds of tasks show every failed task, the full DAG and a real progress bar.
36. **Director jobs (tasks that are themselves jobs)** — a job whose tasks are all `run_job_task` is handled as a first-class case. The sentinel is detected **structurally** (the DAG leaf running `run_if=ALL_DONE`) instead of by name, so a rename cannot hide it. Drilling into a failed sub-job opens **the run that parent actually triggered**, not the child job's latest run. Repair on a sub-job task warns first, because it pulls in the flows that depend on it — but it is **surgical inside the child**: measured 2026-09-08 against a throwaway director, repairing the parent propagates as a **repair of the child run** (same child `run_id`, only the failed task and its dependents re-run, already-successful tasks keep their original `start_time`). Repairing the child run directly is **rejected by the API** (`"Repair is not allowed on runs triggered by a Run Job task"`), so the parent is the only entry point. ⚠ Repairing a downstream task on its own with `rerun_dependent_tasks: false` is a **silent no-op**: it returns a `repair_id` and runs nothing, because its dependency is still failed. The progress bar labels sub-jobs as sub-jobs, and the parameter editor reads job-level `parameters`, not only task `base_parameters`.
### v9 — Sign in with Databricks (OAuth)
37. **OAuth with PKCE per user** — workspaces default to *Connect with Databricks* (user-to-machine OAuth, public client, no secret); tokens refresh by themselves and live only in the user's `UserProperties`. PAT stays available unless the deployment sets `REQUIRE_OAUTH`. See [Authentication](#authentication).
38. **Per-user scheduled runs** — scheduled runs are stored per user without any token, and run with the scheduler's own credentials. Before, the list lived in shared Script Properties with a copy of each user's token, and any user's trigger ran everybody's items.
39. **No token in the browser** — `getConfig()` returns whether the workspace is connected, never the credential.

35. **Sentinel-aware diagnosis** — a *sentinel* task (one that exists only to force the run to `FAILED` when something inside it failed, because `run_if=ALL_DONE` would otherwise close the run green) is detected, pushed to the bottom of the failed-task list and rendered with a `sentinel — not the cause` chip: no AI diagnosis, no Think Fix, excluded from Repair. The real failure becomes the primary card. If the sentinel is the *only* failure, it is treated as a normal failure and diagnosed.

---

## Architecture

```
Phone
  │
  ▼
[Web App URL]
  │  google.script.run.*()
  ▼
[codigo.gs — Apps Script V8]
  │
  ├─ getDashboard()
  │    └─ /api/2.1/jobs/list (paginated, limit=100) + /api/2.1/jobs/runs/list (last 5 runs per job, batches of 20)
  │
  ├─ getOrchestratorStatus()
  │    └─ /api/2.1/jobs/runs/list?job_id={pinned_job_id}&limit=1
  │    └─ (if RUNNING) /api/2.1/jobs/runs/get → count SUCCESS tasks
  │
  ├─ getJobDetail(jobId)
  │    └─ /api/2.1/jobs/runs/list?limit=10 → run_history
  │    └─ _getRunDetailPaged() → /api/2.2/jobs/runs/get (follows next_page_token, 100 tasks/page)
  │    └─ (if FAILED) tasks + thinkFix (sentinel tasks skipped)
  │
  ├─ triggerJob(jobId)          └─ POST /api/2.1/jobs/run-now
  ├─ repairRun(runId, taskKeys) └─ POST /api/2.1/jobs/runs/repair
  ├─ cancelRun(runId)           └─ POST /api/2.1/jobs/runs/cancel
  │
  ├─ pensarFix(runId, taskKey, lang, userHint)
  │    └─ (optional userHint injected into both LLM passes via _buildHintBlock)
  │    └─ LLM decides which DESCRIBE TABLE to run
  │    └─ /api/1.2/contexts/create + /api/1.2/commands/execute (Hive Metastore)
  │    └─ LLM proposes find → replace with real schema
  │
  ├─ aplicarFix(path, find, replace)
  │    └─ /api/2.0/workspace/export → replace → /api/2.0/workspace/import
  │
  ├─ getFavorites() / toggleFavorite(jobId)    — UserProperties
  ├─ getFixHistory()                            — UserProperties
  ├─ getConfig() / saveConfig(config)          — UserProperties 'bedbricks_config'
  ├─ getServingEndpoints()                      — /api/2.0/serving-endpoints (READY only)
  ├─ setPinnedJob(jobId, jobName) / clearPinnedJob()
  │
  └─ doGet() → Index.html

[Index.html — mobile UI]
  ├─ Header: logo + dark/light toggle + ↻ auto-refresh countdown
  ├─ Tab Jobs: pinned job widget + search + filters + job list with ★ 📌
  ├─ Tab Runs: global run history
  ├─ Tab Fixes: applied patches log
  ├─ Tab Settings (⚙): connection, LLM endpoint, pinned job
  └─ Detail view: status + run history + Cancel + AI diagnosis + Repair + Think Fix
```

---

## Authentication

Each workspace signs in one of two ways:

| Mode | How | Where the credential lives |
|------|-----|----------------------------|
| **Databricks login (OAuth)** — default | User-to-machine OAuth with PKCE. The user taps **Connect with Databricks**, signs in on their workspace and comes back. Tokens refresh by themselves. | The user's own `UserProperties`, via the [apps-script-oauth2](https://github.com/googleworkspace/apps-script-oauth2) library. Never shared. |
| **Personal Access Token** | Paste a `dapi…` token. | The user's own `UserProperties`. |

**Setting up OAuth (once per workspace, by a Databricks admin):** in the account console, create an OAuth app connection as a **public client** (no secret) with PKCE, scopes `all-apis` and `offline_access`, and this redirect URL:

```
https://script.google.com/macros/d/<YOUR_SCRIPT_ID>/usercallback
```

Then either each user enters the client id in the workspace settings, or the deployment sets it once for everybody (below). If a refresh token goes unused for the workspace's limit (typically 7 days), Bedbricks asks the user to connect again.

**Script Properties (optional, per deployment):**

| Key | Effect |
|-----|--------|
| `OAUTH_CLIENT_ID` | Default OAuth client id for workspaces that do not set their own. |
| `REQUIRE_OAUTH` | `true` hides and refuses PAT mode, and wipes any PAT a user had saved the next time they open the app. |
| `OAUTH_REDIRECT_URI` | Overrides the callback URL. On a Google Workspace domain set `https://script.google.com/a/macros/<your-domain>/d/<YOUR_SCRIPT_ID>/usercallback` (and register it in the Databricks OAuth app first): the generic URL opens with the browser's **default** Google account, so users signed in to several accounts get *"Authorization is required to perform that action"* when coming back from Databricks. **If `/usercallback` still fails** (some Workspace domains never run the callback: same message, no `authCallback` in Executions), set it to the web app's own `/exec` URL instead (e.g. `https://script.google.com/a/macros/<your-domain>/s/<DEPLOYMENT_ID>/exec`) and register that URL: Bedbricks then does PKCE itself and the web app receives the code. |

Scheduled runs use the token of the user who scheduled them, at run time: the time-based trigger runs as that user and reads their own credentials. Nothing is copied to shared storage.

---

## Persistence

All data lives in Google's `UserProperties` — per-user, cross-device, no external database.

| Key | Contents | Limit |
|-----|----------|-------|
| `bedbricks_config` | `{active, lang, workspaces: [{name, host, auth, client_id, token, llm_endpoint, pinned_job_id, pinned_job_name}]}` (`token` only in PAT mode) | — |
| `oauth2.dbx_<host>` | OAuth tokens for one workspace host (managed by the library) | — |
| `bedbricks_scheduled` | `[{id, jobId, jobName, epochMs, host, createdAt, error?}]` — this user's scheduled runs, no token | — |
| `repair_<runId>` | last `repair_id` for chained repairs | — |
| `favorites` | JSON array of job IDs | — |
| `fix_history` | `[{ts, notebook_path, find_preview, replace_preview}]` | 50 (FIFO) |

---

## Access control

By default, anyone with the link can access the app. To restrict to specific emails, add `ALLOWED_EMAILS` in **Apps Script → Project Settings → Script Properties**:

```
Key:   ALLOWED_EMAILS
Value: alice@example.com,bob@example.com
```

Leave empty (or don't add it) to allow any Google account.

---

## Setup

You need: a **Databricks workspace + personal access token** (`dapi...`) and a **Google account**. Everything else depends on which install method you choose.

> **First-time deployment** (any method): after the code is in Apps Script you must create the Web App once manually — see [Create the Web App](#create-the-web-app) below.

---

### Method A — Manual (no tools required)

The simplest path. Just copy two files into the Apps Script editor.

1. Go to [script.google.com](https://script.google.com) → **New project** → rename it to `Bedbricks`
2. Delete the default `Code.gs` content. Paste the contents of [`apps_script/codigo.gs`](apps_script/codigo.gs)
3. **File → New → HTML file** → name it `Index` → paste the contents of [`apps_script/Index.html`](apps_script/Index.html)
4. **File → New → Script file** (optional) or edit `appsscript.json` via **Project Settings → Show appsscript.json** → paste [`apps_script/appsscript.json`](apps_script/appsscript.json)
5. Save → proceed to [Create the Web App](#create-the-web-app)

---

### Method B — CLASP (Node.js CLI)

Google's official CLI. Handles auth automatically — no Cloud Console setup needed.

```bash
npm install -g @google/clasp
clasp login                      # opens browser for Google OAuth
clasp create --title "Bedbricks" --type webapp --rootDir apps_script
clasp push
```

Then proceed to [Create the Web App](#create-the-web-app).

> **Re-deploying after changes:**
> ```bash
> clasp push
> ```

---

### Method C — Python deploy script (automation / no Node.js)

No CLASP, no Node. Pure Python — useful for scripting or CI.

**One-time setup:**

1. Create a Google Cloud project at [console.cloud.google.com](https://console.cloud.google.com)
2. APIs & Services → Credentials → **Create credentials → OAuth 2.0 Client ID** → Application type: **Desktop App**
3. Enable the **Google Apps Script API** for your project
4. Copy Client ID and Client Secret

```bash
cp deploy_config.example.py deploy_config.py
# Fill in: SCRIPT_ID (from script.google.com → Project Settings)
#          CLIENT_ID and CLIENT_SECRET (from step above)
```

**Authenticate (first time only):**

```bash
python deploy_apps_script.py --auth
```

Opens a browser for Google OAuth. Token saved to `~/.apps_script_token.json`.

**Deploy:**

```bash
python deploy_apps_script.py
```

Then proceed to [Create the Web App](#create-the-web-app). After the first deployment, add `DEPLOYMENT_ID` to `deploy_config.py` and re-run to keep it updated automatically.

---

### Create the Web App

This step is the same regardless of install method. Do it once in the Apps Script editor:

1. **Deploy → New deployment** → Type: **Web App**
2. Execute as: **User accessing the web app** ← important (see note below)
3. Who has access: **Anyone within `<your org>`** (or "Anyone with a Google Account")
4. **Deploy** → copy the **Web App URL**

Open the URL on your phone. The setup wizard will ask for your Databricks host and token — that's it.

> **⚠ Execute as — must be "User accessing the web app".** Bedbricks stores each person's host/token/workspaces in their own `UserProperties`, which is keyed to the *effective* user. If you deploy with "Execute as: Me", **every visitor runs as you and shares your token and workspaces** — the per-user model breaks. "User accessing" makes each person run as themselves (their own token, isolated). The trade-off: each user authorizes the OAuth scopes once on first open (a normal Google consent screen).
>
> **This setting is UI-only.** The `webapp.executeAs`/`access` values in `appsscript.json` are *not* applied when you create/update a deployment via the API or `clasp` — Google fixes them from the dialog at deployment-creation time. Set them in **Deploy → New deployment** (or Manage deployments → Edit) in the browser.

> **Updating** (after code changes): use **Deploy → Manage deployments → Edit → New version** instead of creating a new deployment, so your URL stays the same. (Changing *Execute as* on an existing deployment is often locked — if so, create a **New deployment**, which yields a new URL.)

---

### Optional: AI features (Think Fix)

Think Fix requires a Databricks **Model Serving endpoint**. If you have one, you can select it from the Settings tab (⚙) — it's populated automatically from your workspace. The app works fully without it; Think Fix is just hidden.

---

## Development

### File structure

```
bedbricks/
├── README.md
├── deploy_apps_script.py        ← deploy via Apps Script API (no CLASP needed)
├── deploy_config.example.py     ← template: copy to deploy_config.py
├── deploy_config.py             ← gitignored — your Script ID + Deployment ID
├── .gitignore
├── apps_script/
│   ├── appsscript.json          ← manifest: OAuth scopes, runtime V8
│   ├── codigo.gs                ← backend: GAS functions
│   └── Index.html               ← frontend: mobile UI, embedded logo
└── tests/
    └── test_logic.js            ← 78 pure-logic tests (no GAS APIs required)
```

### Tests

```bash
node tests/test_logic.js
# 154 passed, 0 failed
```

Tests cover all pure helpers: `_parseConfig`, `_isConfigComplete`, `_parseServingEndpoints`, `_buildLlmPayload`, `_parseLlmResponse`, `_parseFailedTask`, `_parseFailedTasks`, `_buildRepairPayload`, `_parseFavorites`, `_toggleFavoriteLogic`, `_buildCancelPayload`, `_appendFixLog`, `_parseRunHistory`, `_extractTaskMeta`, `_getTaskChipType`, `_computeFlakiness`, `_gestureDelta`, `_buildManifest`, `_buildRunComparison`, `_globalSearch`, `_paramsToMap`, `_buildRunNowPayload`, `_buildHintBlock`, `_mergeRunPages`, `_runPageUrl`, `_dedupTasksByKey`, `_isSentinelTask`, `_sortFailedTasks`, `_sentinelKeys`, `_childRunId`, `_mergeJobParams`, `_countsAreSubjobs`.

---

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-06-04 | v1 | Initial: TDD scaffold, full GAS backend, dark mode frontend, deploy script |
| 2026-06-04 | v2–v7 | Remote control: dashboard, job detail, trigger. Tab Jobs, Tab Runs, detail view. |
| 2026-06-04 | v8–v12 | `repairRun()` with auto `latest_repair_id`. Timezone. Refresh button. |
| 2026-06-04 | v13–v18 | `pensarFix()` — LLM + Hive Metastore → concrete find → replace. |
| 2026-06-04 | v19–v22 | Multi-task failures, sub-jobs, Repair All. |
| 2026-06-04 | v23–v25 | Databricks-inspired theme: CSS vars, square dots, bordered badges. |
| 2026-06-05 | v26 | Widget, auto-refresh 30s, filters, favorites, cancel run, run history, Fixes tab. |
| 2026-06-05 | v27–v30 | Bedbricks rebrand: embedded logo, dark/light SVG toggle. |
| 2026-06-05 | v31–v33 | Multi-user: per-user config, setup wizard, Settings tab (⚙), Pin Job (📌), configurable LLM endpoint, English UI, marquee for long names. |
| 2026-06-05 | v42 | Full i18n EN/ES: `STRINGS` dict + `t(key)` + `setLang()`, `data-i18n` attrs, persisted in `UserProperties`. LLM prompts bilingual. |
| 2026-06-05 | v43 | Diff visual (LCS), Tab Clusters (start/terminate), Scheduler one-shot (GAS triggers), Perf chart (SVG), Task DAG (SVG). |
| 2026-06-05 | v44 | Replace emoji icons (clusters tab, schedule btn) with minimalist SVG icons. |
| 2026-06-05 | v45 | **Critical fix:** detail view stuck on "Loading..." for any run. Root cause: `var t = data.tasks[i]` inside `renderDetail()` hoisted `t`, shadowing the global i18n `t()` → `TypeError: t is not a function` in the success handler (silent). Fix: rename loop var `t` → `task`. |
| 2026-06-05 | v46–v49 | Logo doubled in visible size (58px → 96px); header switched to `height:auto` to fit the logo. |
| 2026-06-09 | v50 | PWA installable (manifest + iOS/Android meta tags). Swipe gestures: tab navigation, swipe-row quick actions (▶ trigger / ★ favorite), pull-to-refresh. Per-task flakiness score: % badge in task list and DAG (red >20%, amber 10–20%). |
| 2026-06-09 | v51–v52 | **Task Code Viewer:** `{ } code` / `↗ subjob` chips per task row. Notebook tasks: 30-line preview with fade + expand to full code (on-demand `workspace/export`). run_job tasks: panel with referenced job name + direct navigation. `_extractTaskMeta()` + `getNotebookPreview(path, full)`. Light mode as default theme. 51 tests. |
| 2026-06-09 | v53 | **Light-mode fix:** diagnosis card `strong` and inline `code` used fixed dark colors (invisible on light bg). Fixed to `var(--text)` / explicit light color. |
| 2026-06-10 | v54 | **Drill into failed sub-jobs:** a failed `run_job` task now shows an "open child job →" button that navigates to the child run. `_parseFailedTasks` captures `subjob_id`; `getJobDetail` resolves `subjob_name`. |
| 2026-06-10 | v55 | **Repair fixes:** `rerun_tasks` was sent nested (`[["task"]]`) → 400 MALFORMED_REQUEST (Repair was fully broken). Now a flat array + `rerun_dependent_tasks:true` (the DAG continues). `latest_repair_id` persisted in `UserProperties` (the API never returns `repair_history`). Verified against live Databricks. |
| 2026-06-10 | v56 | **Critical fix — blank FAILED screen:** `flakiness` (declared in `renderDetail`) was used inside `renderFailedUI` (a separate function) → `ReferenceError` → the whole FAILED UI failed to render for jobs with a DAG of ≥2 tasks. Broken since v50. Fix: pass `flakiness` as a parameter. |
| 2026-06-10 | v57 | **V6 — Power features:** parameter editor (key-value modal → `notebook_params`), global search (header overlay: jobs/runs/IDs), run comparison (two-run picker + per-task duration table with delta). 69 tests. |
| 2026-06-10 | v58 | Fix iOS auto-zoom: search and params inputs to `font-size:16px` (the full-screen overlay pushed Back off-screen). |
| 2026-06-10 | v59 | Fix run comparison "?": `_fetchRunsWithTasks` used the 2.1 endpoint (400 on large runs) and parsed the error body as an empty run. Now 2.2 + HTTP-code check + fallback. Also fixes flakiness on large jobs. |
| 2026-06-10 | v60 | Comparison table `table-layout:fixed` + Task column with ellipsis (no longer overflows the screen). |
| 2026-06-10 | v61–v62 | Per-job status dots: `runs/list?job_id&limit=5` per job in parallel (mirrors Databricks' last 5). Reverted global `limit=100` → 25 (the endpoint max). |
| 2026-06-10 | v63 | **Universal UI:** loading spinner, icon set (▶ ✓ ✕ ‹), fixed hard-coded translations (Repair, Task Code Viewer, Install) + `data-i18n-title` for localized tooltips. |
| 2026-06-10 | v64 | 🔧 Repair / 💡 Think Fix with text labels (more intuitive); sun icon with a filled center (no longer mistaken for the settings gear); **bilingual AI diagnosis** (ES/EN prompt + `getJobDetail(jobId, lang)`). |
| 2026-06-10 | v65 | Smarter Think Fix for missing tables: searches the metastore (`SHOW TABLES`) for the correct one, or comments out the line as a last resort (never an empty fix). |
| 2026-06-10 | v66 | Fix: `switchTab` did not close the `detail-view` overlay → it stayed underneath when changing tabs. |
| 2026-06-10 | v67 | **Detailed Fixes log:** expandable entries with full red/green diffs; backend stores `find`/`replace` (cap 800) + a `UserProperties` size guard. |
| 2026-06-10 | v68 | **Multi-workspace:** config refactored to `{active, lang, workspaces[]}` with automatic migration; add/edit/delete/switch from Settings; `_getConfig_()` returns the active workspace flattened (no call-site changes). 78 tests. |
| 2026-06-10 | v69 | Removed model-specific labels: AI diagnosis card now reads "AI Diagnosis" / "Diagnóstico IA" (the endpoint is configurable). |
| 2026-06-10 | v71 | **Log out / reset** button in Settings → `resetConfig()` clears all saved workspaces & tokens and returns to the setup wizard. |
| 2026-06-10 | v72 | Setup screen polish: corrected tagline, Connect button as a single arrow, and **trimmed the logo** (was 480×251 with ~64% transparent margin → cropped to content) so it renders crisp and the layout is balanced. |
| 2026-06-11 | v73 | **Think Fix hint:** tapping 💡 Think Fix now opens an optional free-text field — give the AI a suggestion (e.g. "the table was renamed to X") before it diagnoses. The hint is injected into both LLM passes (schema discovery + fix) and bilingual; the system prompt weighs it heavily but still validates against the real schemas. Empty hint = fully automatic, same as before. New pure helper `_buildHintBlock(hint, lang)` + 7 tests (81 total). |
| 2026-06-11 | v74 | Public-repo hygiene: replaced internal example identifiers with neutral ones (`analytics.customers_v2`, generic job IDs) across the hint placeholder and `test_logic.js` fixtures, so nothing real-world ships in the open-source release. No behaviour change. |
| 2026-09-01 | v79 | **`runs/get` was never paginated.** The API caps at 100 tasks per page; on an orchestrator job with hundreds of tasks only page 1 was read, so the only FAILED task Bedbricks could see was the **sentinel** (the single DAG leaf, which lands on page 1) — Think Fix always diagnosed its useless traceback while the real failures sat on page 2. Fixed in all three readers (`getJobDetail`, `_fetchRunsWithTasks`, `getOrchestratorStatus`; the last one also moved off API 2.1, which returns `400 Resources with more than 100 tasks...` — swallowed by a `catch`, so the widget progress bar had always read 0/0). Sentinel tasks are now detected, sorted last, shown with a `sentinel — not the cause` chip and skipped for diagnosis/Think Fix/Repair. `tasks` also carries **one entry per attempt**, not per task (after repairs, roughly twice as many entries as tasks) → deduped by `task_key` keeping the last attempt. 95 tests. |
| 2026-09-06 | v81 | **The v79 pagination fix reached 3 of the 4 readers — `pensarFix()` was the one left behind.** Think Fix kept calling `runs/get` **unpaginated**, so on a >100-task orchestrator the actually-failing task (page 2) was never found: it silently fell through with `notebookPath = null`, the LLM diagnosed with an **empty** `notebookContent`, and the find→replace it invented could never match — surfacing as *"the code to replace was not found in the notebook"*, which reads like a notebook problem and is really a **paging** one. The paginated helper (`_getRunDetailPaged`) already existed and every other reader used it. Fixed by extracting `_findTaskInRun()` — paginate **and** dedupe by `task_key` keeping the last attempt, since with retries the first entry carries the wrong traceback. Now **fails loudly** when the task isn't in the run instead of diagnosing blind: a diagnosis without code is a made-up patch. 6 regression tests (**101**). |
| 2026-09-06 | v82 | **Same bug, the other endpoint: `jobs/get` was still on API 2.1.** 2.1 does not degrade — it returns `400 Resources with more than 100 tasks can only be handled by API 2.2`, and a `catch` turned that into *"no data"* silently: `getJobParams()` returned `{}` on any >100-task job, so the **custom Run Now parameter editor was always empty**. Switching to 2.2 alone is not enough either — it answers 200 but truncates `settings.tasks` to 100 (measured on a real job: only a fraction of the tasks that carry `base_parameters` land on page 1). Added `_getJobDetailPaged()` / `_mergeJobPages()`, which accumulate `settings.tasks` across pages while keeping the page-1-only top-level fields (`name`, `parameters`, `job_clusters`). Both 2.1 callers migrated (`getJobParams`, sub-job name lookup); **zero raw `runs/get` or `jobs/get` calls left in the file**. 6 more tests (**107**). |
| 2026-09-06 | v83 | **Think Fix sent the LLM "the first N characters" of the notebook — the worst possible heuristic, because the error is almost never at the top.** Measured on a real notebook: ~21k chars, with the failing cell starting just past the 10,000-char cut, so even after v81 handed the LLM real code, it was the wrong half. Replaced by `_selectRelevantCode()`: split the notebook on Databricks' `# COMMAND` separators, pull **anchors** from the traceback (ANSI colour stripped first, or `roster` and `mroster` count as two), score each cell by how many *rare* anchors it holds (a pocket tf-idf — `spark` in a PySpark notebook distinguishes nothing), and emit the winning cells **in original order**, verbatim, with explicit `[ ... N cells omitted ... ]` markers; the system prompt now forbids spanning a marker in `find`. A cell bigger than the budget is cropped **around** its anchor, not from the top. Two defects the real-data check caught and the unit tests hadn't: adjacent chosen cells were glued **without** their `# COMMAND ----------`, producing text that exists nowhere in the notebook (so `find` could never match — the very bug being fixed); and the gap markers weren't counted against the budget (144 chars returned for a 140 budget). Result on that notebook: the failing cell now makes it in at **both** the 3,000 and 8,000 budgets, and every emitted section is verbatim. 13 more tests (**120**), including a budget sweep over 77 sizes and a guard that the inline test copy hasn't drifted from `codigo.gs`. |
| 2026-09-07 | v84 | **A job whose tasks are all sub-jobs — a "director" — was the one shape where every safety net missed at once.** Four independent defects, all of them silent. (1) **Sentinel detection was by name.** `_isSentinelTask` matched the substrings `centinela`/`sentinel`; rename the task and it becomes invisible. On a director that is not cosmetic: every *other* failed task is a `run_job`, and `run_job` tasks are deliberately not diagnosed — so the undetected sentinel became the **only** task with an AI diagnosis, a Think Fix button and a slot in Repair, i.e. exactly the v79 bug re-entering through a rename. Replaced by a **structural** rule — the DAG leaf whose `run_if` is `ALL_DONE` with ≥2 dependencies — calibrated against a real multi-hundred-task DAG where it isolates the sentinel with **zero false positives** (of its `ALL_DONE` tasks only the sentinel is a leaf; the wide gate has dozens of dependents, so it is not one). The name match is kept as an OR, never as the only signal. (2) **Drilling into a failed sub-job opened the wrong run.** The button called `showDetail(job_id)` → `runs/list` → `runs[0]`, the child's **latest** run — a different run whenever you open an older parent run from the history, after a repair, or after someone re-ran the child by hand, with nothing on screen saying so. The child run id is **not** in `runs/get` (`run_job_output` is null there, measured): it comes from `runs/get-output` on the parent **task**'s `run_id`. New `getRunDetail(runId)` + `showRunDetail()` navigate to that exact run, falling back to the job with a different tooltip when it cannot be resolved. (3) **Repair silently changed meaning.** Repairing a `run_job` task re-runs the **entire child job**, not the task that failed inside it — a whole wave. Now it confirms first. (4) **The parameter editor was empty and the progress bar mislabelled.** `getJobParams` only merged `notebook_task.base_parameters`; a director has none, and its parameters live in job-level `settings.parameters` (which `run_job_task` does propagate) — same symptom v82 fixed, different cause. And the bar counted waves while calling them "tasks", off by more than an order of magnitude. **Plus a generalized sync guard:** 36 pure helpers live duplicated between `codigo.gs` and the tests, and the old guard covered one block. `SYNC2`/`SYNC3` now compare every shared helper modulo comments — which surfaced **5 pre-existing drifts** where the inline copy certifies a superseded version (`_buildFixLogEntry`, `_appendFixLog`, `_buildLlmPayload`, `_parseConfig`, `_parseLlmResponse`), documented so the list can only shrink. 21 more tests (**141**). |
| 2026-10-26 | v89 | **OAuth return through the web app (`/exec`).** On a Google Workspace domain `/usercallback` answered *"Authorization is required to perform that action"* without ever running `authCallback` (owner, every scope granted, incognito). With `OAUTH_REDIRECT_URI` ending in `/exec`, `getAuthUrl` builds the authorize URL itself (S256 challenge, random `state`; state + verifier in the user's `UserProperties`, single use, 10 min) and `doGet` exchanges the code and stores the token in the OAuth2 library's own slot, so refresh is unchanged. The `/usercallback` path stays for every other value. |
| 2026-10-27 | v90 | **The Jobs tab only showed the first 20 jobs.** `getDashboard()` called `jobs/list` once, without `limit` or `page_token`; the API answers 20 jobs plus `has_more`, and since the list is sorted by name on the client the cut was invisible — whole groups of jobs were simply missing. New `_listAllJobs()` asks for `limit=100` (the API maximum: 101 is a 400) and follows `next_page_token`, with a 20-page guard and dedup by `job_id` (`_mergeJobListPages`). With more jobs, the per-job status dots (`runs/list` per job) now go out in batches of 20, one `fetchAll` per batch, and a `429` is retried once. 5 more tests (**154**). |
| 2026-10-22 | v85 | **Sign in with Databricks (OAuth, PKCE, per user).** Workspaces default to *Connect with Databricks*: user-to-machine OAuth against a public client (no secret) via the `apps-script-oauth2` library, tokens in the user's own `UserProperties`, automatic refresh, and a typed `NEEDS_AUTH` that the UI turns into a *Connect* button (never authorized, or refresh token expired). The library always sends `client_secret` in the token request, even empty; a payload handler strips it so public clients work. PAT stays as an option; `REQUIRE_OAUTH` (Script Property) refuses it and wipes saved PATs on the next open; `OAUTH_CLIENT_ID` sets a default client id. **Scheduled runs fixed:** they lived in shared Script Properties with a copy of each user's host + token, and `_onScheduledRun` (which runs as the trigger's owner) fired **everybody's** items — now per user, no token, run with the scheduler's own credentials, failures kept in the list with the error. `getConfig()` no longer sends the token to the browser. The `_parseConfig` drift is gone (synced, not just listed). 8 more tests (**149**). |
| 2026-06-12 | v78 | Think Fix no longer auto-focuses the hint textarea (the mobile keyboard popped up on every tap). The hint field just reveals + scrolls into view; the keyboard opens only if the user taps it — the hint is optional. |
| 2026-06-12 | v77 | After a successful Apply Fix, that task's **Think Fix button also locks** (disabled) — not just the apply button — so a patched notebook can't be re-diagnosed by accident. |
| 2026-06-12 | v76 | Code-error warning banner reworked: dropped the stray `! ` text prefix, added a proper ⚠ icon in a flex layout (icon aligned to the first line), and reworded the message to point at Think Fix (EN/ES). |
| 2026-06-12 | v75 | **Three fixes.** (1) **Per-task AI diagnosis:** when a job fails with several FAILED tasks, each task now gets its OWN error trace + its OWN diagnosis card (before, only the first task was diagnosed). `getJobDetail` diagnoses per task; `renderFailedUI` renders one diagnosis card per failed task (+ its own raw log and Think Fix). (2) **Removed swipe-to-switch-tabs:** the horizontal tab-swipe gesture hijacked horizontal scroll when reading full notebook code in the detail view — removed; pull-to-refresh and swipe-on-a-row quick actions stay. (3) **Apply-fix button locks:** each Think Fix panel owns its apply button (unique id + per-panel fix in `_fixByPanel`) and stays disabled after a successful apply — no more repeat taps (previously all panels shared `btn-apply-fix`/`_pendingFix`, so in multi-task only the first button disabled). |
