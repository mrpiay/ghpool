# ghpool — complete tutorial

**ghpool** is a Python script that watches GitHub's public Events API and prints pull requests, stars, issues, forks, and releases happening across all public repos in real time, every 5 seconds.

Optionally, every session can be recorded to a local SQLite database via [worktrace](https://github.com/Pedro-Oub/worktrace) (pass `--no-record` to skip). That means you can stop the script, come back later, and query the full history: which repos were most active, how many PRs merged in the last hour, what a specific user was working on. The terminal ticker and the queryable timeline are the same tool.

---

## Part 1 — how ghpool came about

### Starting point: worktrace

[worktrace](https://github.com/Pedro-Oub/worktrace) is a Python library by Pedro-Oub. It gives any script a structured, queryable history stored in a local SQLite file at `~/.worktrace/worktrace.db`. No server, no config, no schema definition. Three primitives:

- **Run** — one execution of your script
- **Event** — a timestamped thing that happened during a run
- **Snapshot** — a full state capture of something at a point in time

### Looking for a use case

The goal was to find a use case where:

1. **State changes constantly on its own** — so every snapshot differs from the last
2. **No auth required** (or easy to get) — so anyone can reproduce it
3. **No polished real-time visualization already exists** — so building one has actual value

### The pick: GitHub's global PR stream

GitHub exposes a public Events API (`api.github.com/events`) that returns the most recent public activity across all of GitHub — every push, star, fork, issue, and pull request, updated every few seconds.

The name ghpool comes from [mempool.space](https://mempool.space), a real-time visualization of Bitcoin's transaction queue. There are per-org dashboards (Graphite, Pullp) and GitHub's own PR inbox, but nothing that visualizes activity flowing across all of GitHub in real time. ghpool is that tool.

---

## Part 2 — setup

### Requirements

- Python 3.10+
- A free GitHub account (for the token)

### Install

From the `ghpool` folder:

```bash
python -m venv .venv
source .venv/Scripts/activate      # Windows Git Bash
                                   # PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

`requirements.txt` installs:
- `worktrace` — run history, events, and snapshots
- `requests` — HTTP calls to the GitHub API
- `python-dotenv` — loads the GitHub token from `.env`
- `rich` — colored terminal output

### GitHub token

Without a token the API allows 60 requests/hour — one per minute. With a free token: 5000/hour — one every ~0.7 seconds. ghpool polls every 5 seconds so the token is what makes it feel real-time.

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
2. **Generate new token** → name it "ghpool" → **no scopes needed** → generate
3. Create a `.env` file in the `ghpool` folder:

```
GITHUB_TOKEN=ghp_yourtoken123abc
```

`.env` is in `.gitignore` — it will never be committed.

---

## Part 3 — running ghpool

### One-terminal flow (simplest)

Everything in a single terminal. Good for a first run.

**Step 1 — open a terminal and go to the project folder**

```bash
cd /c/ghpool
```

**Step 2 — activate the venv**

```bash
source .venv/Scripts/activate
```

Your prompt should now start with `(.venv)`.

**Step 3 — run ghpool**

```bash
python ghpool.py
```

You will see:

```
ghpool — live GitHub PR stream  (Ctrl+C to stop)  · recording on

token loaded · 100 events fetched

09:51:23  PR  opened (1) by crtahlin (1) · 0s
          GasperX93/swarm-notify  [+3632 -0]
          Web UI reference app with use cases and developer guidance

09:51:24  PR  merged (1) by dependabot (1) · 1s
          lightdash/lightdash  [+3 -3]
          build(deps): bump express from 4.18.2 to 4.19.2

Watching for new events every 5s...
```

The first batch shows existing events from the current GitHub event window. After that, new events appear every 5 seconds as they happen globally.

To run without recording to the database:

```bash
python ghpool.py --no-record
```

The title line shows `· recording on` (green) or `· recording off` (red) so you always know.

**Step 4 — stop and inspect**

Press `Ctrl+C` to stop. The run is saved cleanly. Then:

```bash
# list your sessions
worktrace runs --tag github

# inspect the last session (copy the ID prefix from the runs list)
worktrace show-run <id-prefix>
```

---

### Two-terminal flow (recommended — watch events live while ghpool runs)

**Terminal A** — runs ghpool and produces events.
**Terminal B** — tails the worktrace database and shows events as they are written.

They communicate through the SQLite file at `~/.worktrace/worktrace.db`. Neither terminal needs to know about the other.

---

**Step 1 — open Terminal A, go to the project folder**

```bash
cd /c/ghpool
source .venv/Scripts/activate
```

---

**Step 2 — open Terminal B** (new Git Bash window, or `+` in VS Code terminal panel)

```bash
cd /c/ghpool
source .venv/Scripts/activate
```

---

**Step 3 — in Terminal B, start the watcher**

```bash
worktrace tail --type pr.*
```

You will see:

```
Watching events... (Ctrl+C to stop)
```

Then silence. Terminal B is now blocked, waiting for new events. Leave it alone.

---

**Step 4 — in Terminal A, start ghpool**

```bash
python ghpool.py
```

As soon as new events are detected, they appear in **both** terminals simultaneously — in Terminal A as colored cards, in Terminal B as raw structured events from worktrace.

---

**Step 5 — try different tail filters in Terminal B**

Stop the tail with `Ctrl+C`, then try:

```bash
# only merges
worktrace tail --type pr.merged

# only opens
worktrace tail --type pr.opened

# all poll health events
worktrace tail --type poll.*

# one specific repo (if you spotted one in Terminal A)
worktrace tail --resource gh/torvalds/linux

# everything — PRs, polls, session events
worktrace tail
```

Restart with any filter while ghpool keeps running in Terminal A.

---

**Step 6 — inspect a session while it runs**

In Terminal B, while ghpool is still running in Terminal A:

```bash
# list sessions — you should see one with status "running"
worktrace runs --tag github

# inspect it live — events keep appearing as you watch
worktrace show-run <id-prefix>
```

---

### Display format

Each event is printed as a 2–3 line card:

```
HH:MM:SS (UTC)  [type] ACTION (count) by username (count) · elapsed
                owner/repo  [+added -deleted]   ← line counts only for PRs
                title (truncated at 60 chars)    ← omitted if empty
```

Five event types, each with an ASCII prefix:

| Prefix | Type | Color |
|---|---|---|
| `PR` | pull request | action color |
| `*` | star | yellow |
| `#` | issue | action color |
| `FK` | fork | blue |
| `RL` | release | cyan |

PR actions and their colors:

| Action | Display | Color |
|---|---|---|
| opened | opened | green |
| merged | merged | magenta |
| closed | closed | red |
| reopened | reopened | yellow |
| synchronize | pushed | cyan |
| labeled | labeled | blue |
| unlabeled | unlabeled | blue |
| assigned | assigned | yellow |
| unassigned | unassigned | yellow |
| review_requested | rev_req | cyan |
| review_request_removed | rev_req_rm | cyan |
| ready_for_review | ready | green |
| converted_to_draft | draft | white |

Two independent counters per event: action count (how many times this action has been seen) and user count (how many events this user has triggered). Elapsed is time since session start.

---

### Quick reference — all commands

| What | Command |
|---|---|
| Start ghpool | `python ghpool.py` |
| Start without recording | `python ghpool.py --no-record` |
| Watch all PR events live | `worktrace tail --type pr.*` |
| Watch only merges | `worktrace tail --type pr.merged` |
| Watch one repo | `worktrace tail --resource gh/owner/repo` |
| Watch poll health | `worktrace tail --type poll.*` |
| List sessions | `worktrace runs --tag github` |
| Inspect a session | `worktrace show-run <id-prefix>` |
| Only failed sessions | `worktrace runs --tag github --status failed` |
| Sessions from last hour | `worktrace runs --tag github --since -1h` |

---

## Part 4 — what gets recorded

When recording is enabled (the default), ghpool writes to worktrace using three primitives: runs, events, and snapshots. All data lives at `~/.worktrace/worktrace.db` — a local SQLite file. Delete it to start fresh. No server, no account, no sync.

Pass `--no-record` to skip all writes and run as a pure live feed.

### Run

One per script execution.

```
name:     ghpool
tags:     ["github", "prs"]
metadata: {"poll_interval": 5, "token": true}
```

### Events

| Type | Resource | Data | When |
|---|---|---|---|
| `session.start` | — | `seeded_events`, `seeded_prs` | Script launches |
| `session.seed_failed` | — | `error` | Seed fetch fails |
| `poll.start` | `github/events` | — | Each poll cycle begins |
| `poll.done` | `github/events` | `total_events`, `new_prs`, `poll_number` | Each poll cycle ends |
| `poll.failed` | `github/events` | `error` | API call fails |
| `pr.opened` | `gh/<owner/repo>` | `title`, `user`, `added`, `deleted` | New PR opened |
| `pr.merged` | `gh/<owner/repo>` | same | PR merged |
| `pr.closed` | `gh/<owner/repo>` | same | PR closed without merge |
| `pr.reopened` | `gh/<owner/repo>` | same | Closed PR reopened |
| `pr.synchronize` | `gh/<owner/repo>` | same | New commits pushed to open PR |
| `pr.labeled` | `gh/<owner/repo>` | same | Label added |
| `pr.unlabeled` | `gh/<owner/repo>` | same | Label removed |
| `pr.assigned` | `gh/<owner/repo>` | same | Reviewer assigned |
| `pr.unassigned` | `gh/<owner/repo>` | same | Reviewer unassigned |
| `pr.review_requested` | `gh/<owner/repo>` | same | Review requested |
| `pr.review_request_removed` | `gh/<owner/repo>` | same | Review request removed |
| `pr.ready_for_review` | `gh/<owner/repo>` | same | Draft marked ready |
| `pr.converted_to_draft` | `gh/<owner/repo>` | same | PR converted to draft |
| `star.starred` | `gh/<owner/repo>` | `title`, `user`, `added`, `deleted` | Repo starred |
| `issue.opened` | `gh/<owner/repo>` | same | Issue opened |
| `issue.closed` | `gh/<owner/repo>` | same | Issue closed |
| `issue.reopened` | `gh/<owner/repo>` | same | Issue reopened |
| `fork.forked` | `gh/<owner/repo>` | `title` (forked repo name), `user` | Repo forked |
| `release.published` | `gh/<owner/repo>` | `title` (release name/tag), `user` | Release published |
| `session.end` | — | `poll_count`, `total_prs`, `by_action` | Ctrl+C |

### Snapshot (every poll cycle)

```
resource: gh/pr-stream
kind:     activity
data:
  poll_count:             int   — how many polls so far this session
  total_prs_this_session: int   — total PR events seen
  by_action:              dict  — {"opened": 12, "merged": 8, "closed": 3, ...}
  top_repos:              dict  — top 10 repos by PR event count
```

---

## Part 5 — web viewer

The web app at [mrpiay.github.io/ghpool](https://mrpiay.github.io/ghpool/) has two tabs:

- **Feed** — live GitHub activity stream in the browser (no install, no recording)
- **Viewer** — drop your `worktrace.db` to browse sessions and run queries

### Prebuilt queries

The viewer includes 17 prebuilt SQL queries. Select a session to scope queries to it, or run them across all sessions.

| Query | What it shows |
|---|---|
| Sessions | Duration, event counts, and status for each session |
| Poll health | Empty vs productive polls, hit rate, avg events per poll |
| Timeline | Events per minute broken down by type |
| Busiest hours | Events by hour of day (UTC) — PRs, stars, and total |
| Top repos | Most active repos by PR events |
| Hot repos | Most active repos across all event types with unique users |
| Top users | Most active users by PR events |
| Repeat users | Users with multiple PR events, their repo count, and actions |
| PR actions | Count of each PR action: opened, merged, closed, etc. |
| Action ratios | PR actions (opened/merged/closed/reopened), merge %, and totals by event type |
| Activity rate | Per-minute rate of all event types |
| Largest PRs | Biggest PRs by lines added + deleted |
| Bots | Bot accounts detected in PR events (dependabot, renovate, etc.) |
| Most starred | Repos with the most star events |
| Most forked | Repos with the most fork events |
| Issues | Issue actions: opened, closed, reopened, etc. |
| Releases | Recent releases with repo, name, and user |

### Custom SQL

The viewer also has a SQL editor (Ctrl+Enter to run). The database has three tables: `runs`, `events`, `snapshots` — the same schema documented in Part 4 above.

---

## Part 6 — querying your data from the terminal

### CLI queries

```bash
# list all ghpool sessions with timestamps
worktrace runs --tag github

# inspect a full session — every poll cycle and every event
worktrace show-run <id-prefix>

# all events from the last 2 hours
worktrace tail --since -2h
```

### Python query API

```python
from worktrace import query

# --- events ---

# all PR events ever recorded
query.events(type_prefix="pr.*")

# only merges
query.events(type_prefix="pr.merged")

# all activity on a specific repo
query.events(resource="gh/torvalds/linux")

# failed poll cycles
query.events(type_prefix="poll.failed")

# everything from the last 2 hours
query.events(since="-2h")

# all PR events from a specific session
query.events(type_prefix="pr.*", run_id="<full-run-id>")

# --- snapshots ---

# full time-series of session activity snapshots
query.snapshots(resource="gh/pr-stream")

# snapshots from a specific session
query.snapshots(resource="gh/pr-stream", run_id="<full-run-id>")

# --- runs ---

# all sessions
query.runs(tag="github")

# only sessions that completed without errors
query.runs(tag="github", status="success")

# sessions from the last day
query.runs(tag="github", since="-1d")
```

### Example: replay a session's event stream

```python
from worktrace import query

run_id = "<your-run-id>"
for e in query.events(type_prefix="pr.*", run_id=run_id):
    repo = e.resource_uri.replace("gh/", "")
    print(f"{e.timestamp[11:19]}  {e.type:<20}  {repo:<40}  {e.data.get('title','')[:50]}")
```

### Example: top repos across all sessions

```python
from worktrace import query
from collections import Counter

counts = Counter()
for s in query.snapshots(resource="gh/pr-stream", kind="activity"):
    for repo, n in s.data.get("top_repos", {}).items():
        counts[repo] += n

for repo, total in counts.most_common(20):
    print(f"{total:>6}  {repo}")
```

### Example: most active users globally

```python
from worktrace import query
from collections import Counter

counts = Counter()
for e in query.events(type_prefix="pr.*"):
    counts[e.data.get("user", "?")] += 1

for user, n in counts.most_common(20):
    print(f"{n:>6}  {user}")
```

### Example: spot bots

```python
from worktrace import query
from collections import Counter

KNOWN_BOTS = {"dependabot", "renovate", "github-actions", "dependabot[bot]"}

counts = Counter()
for e in query.events(type_prefix="pr.opened"):
    user = e.data.get("user", "")
    if user in KNOWN_BOTS or "[bot]" in user:
        counts[user] += 1

for bot, n in counts.most_common():
    print(f"{n:>6}  {bot}")
```

### Example: largest PRs ever seen

```python
from worktrace import query

events = sorted(
    query.events(type_prefix="pr.*"),
    key=lambda e: e.data.get("added", 0) + e.data.get("deleted", 0),
    reverse=True,
)
for e in events[:10]:
    total = e.data.get("added", 0) + e.data.get("deleted", 0)
    repo = e.resource_uri.replace("gh/", "")
    print(f"{total:>8} lines  {repo}  {e.data.get('title','')[:50]}")
```

### Example: merge ratio

```python
from worktrace import query
from collections import Counter

actions = Counter(e.type for e in query.events(type_prefix="pr.*"))
merged = actions["pr.merged"]
closed = actions["pr.closed"]
ratio = merged / max(1, merged + closed)
print(f"merged: {merged}  closed: {closed}  ratio: {ratio:.0%}")
```

### Example: merge rate over time

```python
from worktrace import query

for s in query.snapshots(resource="gh/pr-stream", kind="activity"):
    merges = s.data.get("by_action", {}).get("merged", 0)
    polls  = s.data.get("poll_count", 1)
    print(f"{s.timestamp[11:19]}  merges/poll: {merges/polls:.2f}")
```

### Example: all activity on a specific repo

```python
from worktrace import query

for e in query.events(resource="gh/torvalds/linux"):
    print(f"{e.timestamp[11:19]}  {e.type}  {e.data.get('user')}  {e.data.get('title','')[:60]}")
```

---

## File structure

```
ghpool/
  ghpool.py        — the script
  requirements.txt — dependencies
  PLAN.md          — original project plan
  TUTORIAL.md      — this file
  .env             — your GitHub token (never committed)
  .gitignore       — excludes .env and .venv
  .venv/           — Python virtual environment
```

---

## Credits

- **worktrace** — [github.com/Pedro-Oub/worktrace](https://github.com/Pedro-Oub/worktrace) by Pedro-Oub. Handles all storage, querying, and the CLI.
- **GitHub Events API** — [docs.github.com/en/rest/activity/events](https://docs.github.com/en/rest/activity/events). Free, public, no special scopes needed.