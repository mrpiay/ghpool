# ghpool — complete tutorial

**ghpool** is a Python script that watches GitHub's public Events API and prints every pull request event happening across all public repos in real time — opens, merges, closes, labels — as they occur, every 5 seconds.

Beyond the live feed, every session is recorded to a local SQLite database via [worktrace](https://github.com/Pedro-Oub/worktrace). That means you can stop the script, come back later, and query the full history: which repos were most active, how many PRs merged in the last hour, what a specific user was working on. The terminal ticker and the queryable timeline are the same tool.

This document covers how the idea came about, how every line of code works, and what you can do with the data it collects.

---

## Part 1 — how ghpool came about

### Starting point: worktrace

[worktrace](https://github.com/Pedro-Oub/worktrace) is a Python library by Pedro-Oub. It gives any script a structured, queryable history stored in a local SQLite file at `~/.worktrace/worktrace.db`. No server, no config, no schema definition. Three primitives:

- **Run** — one execution of your script
- **Event** — a timestamped thing that happened during a run
- **Snapshot** — a full state capture of something at a point in time

The worktrace README demo tracks the Bitcoin mempool: block height, fee rate, and pending transaction count. Every run captures a snapshot — run it on a schedule and you build a timeline of Bitcoin's internal rhythm.

### Looking for a better use case

The mempool demo is good but the visualization already exists at [mempool.space](https://mempool.space). The goal was to find something where:

1. **State changes constantly on its own** — so every snapshot differs from the last
2. **No auth required** (or easy to get) — so anyone can reproduce it
3. **No polished real-time visualization already exists** — so building one has actual value

### The pick: GitHub's global PR stream

GitHub exposes a public Events API (`api.github.com/events`) that returns the most recent public activity across all of GitHub — every push, star, fork, issue, and pull request, updated every few seconds.

The PR activity maps perfectly onto the mempool concept:

| Bitcoin mempool | ghpool |
|---|---|
| Transactions waiting to be confirmed | Open PRs waiting to be merged |
| Transaction size (vB) | PR size (lines changed) |
| Fee rate (sat/vB) | PR "heat" (comments, reviews, approvals) |
| Block mined → mempool empties | Merge wave → PR queue shrinks |

Nothing like mempool.space exists for GitHub's global PR stream. There are per-org dashboards (Graphite, Pullp) and GitHub's own PR inbox, but no one is visualizing the queue of PRs flowing across all of GitHub in real time. ghpool is that tool.

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

## Part 3 — the code, line by line

### Imports and config

```python
import os
import time
import requests
from collections import Counter
from dotenv import load_dotenv
from rich.console import Console
import worktrace as wt

load_dotenv()
```

- `Counter` — Python's built-in dict for counting things. Used to track how many `opened`, `merged`, `closed` events we've seen this session.
- `worktrace as wt` — installed via `pip install worktrace`, aliased to `wt` to keep calls compact.
- `load_dotenv()` — reads `.env` and puts `GITHUB_TOKEN` into the environment.

```python
TOKEN = os.getenv("GITHUB_TOKEN")
HEADERS = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}
POLL_INTERVAL = 5
```

- If the token is present, every API request includes an `Authorization` header. If not, requests are unauthenticated (60 req/hr limit).
- `POLL_INTERVAL = 5` — fetch new events every 5 seconds. Safe with a token. Change to `60` without one.

```python
seen: set[str] = set()
action_counts: Counter = Counter()
repo_counts: Counter = Counter()
poll_count = 0
```

- `seen` — a set of event IDs we've already processed. GitHub returns the same events across multiple polls; this prevents duplicates.
- `action_counts` — running tally of PR actions this session: `{"opened": 12, "merged": 8, ...}`
- `repo_counts` — running tally of which repos have the most PR activity
- `poll_count` — how many poll cycles have completed this session

---

### fetch_events()

```python
def fetch_events() -> list[dict]:
    r = requests.get(
        "https://api.github.com/events",
        headers={**HEADERS, "Accept": "application/vnd.github+json"},
        params={"per_page": 100},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()
```

Calls GitHub's public events endpoint. `per_page=100` gets 100 events per call (default is 30). `raise_for_status()` throws an exception on any HTTP error (4xx, 5xx) so the caller can catch it cleanly.

Returns a list of event dicts. Each event has a `type` field — we only care about `PullRequestEvent`.

---

### fetch_pr_details()

```python
def fetch_pr_details(url: str) -> dict:
    try:
        r = requests.get(url, headers={...}, timeout=8)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {}
```

The GitHub Events API sometimes returns PR events with incomplete payloads — title and user can be null, additions/deletions missing. When that happens, we fetch the full PR object from its own URL (`pr["url"]` in the payload). Returns an empty dict on any failure so the caller always gets something safe to work with.

---

### parse_pr()

```python
def parse_pr(event: dict) -> dict | None:
    if event.get("type") != "PullRequestEvent":
        return None
    try:
        pr = event["payload"]["pull_request"]
        title = (pr.get("title") or "").strip()
        user = (pr.get("user") or {}).get("login", "")
        added = pr.get("additions")
        deleted = pr.get("deletions")

        if not title or not user or added is None:
            details = fetch_pr_details(pr.get("url", ""))
            title = title or (details.get("title") or "")
            user = user or (details.get("user") or {}).get("login", "?")
            added = added if added is not None else details.get("additions", 0)
            deleted = deleted if deleted is not None else details.get("deletions", 0)

        return {
            "id": event["id"],
            "action": event["payload"].get("action", "?"),
            "repo": event["repo"]["name"],
            "title": title[:80],
            "added": added or 0,
            "deleted": deleted or 0,
            "user": user,
            "time": event["created_at"][11:19],
        }
    except (KeyError, TypeError):
        return None
```

Turns a raw GitHub event dict into a clean PR dict. Steps:

1. Skip anything that isn't a `PullRequestEvent`
2. Extract title, user, additions, deletions from the payload
3. If any are missing, call `fetch_pr_details()` to get the full object
4. Return a flat, clean dict — or `None` if anything goes wrong

`title[:80]` caps the title at 80 characters for display. `added or 0` converts `None` to `0`.

---

### render_pr()

```python
def render_pr(pr: dict) -> None:
    color = ACTION_COLOR.get(pr["action"], "white")
    size = f"[dim]+{pr['added']} -{pr['deleted']}[/dim]"
    console.print(
        f"[dim]{pr['time']}[/dim]  [{color}]{pr['action']}[/{color}]  "
        f"[bold]{pr['repo']}[/bold]  [dim]{pr['user']}[/dim]"
    )
    if pr["title"]:
        console.print(f"  {pr['title']}  {size}")
    console.print()
```

Prints one PR as a two-line card. Rich markup (`[green]`, `[bold]`, `[dim]`) handles colors. Each action gets its own color:

| Action | Color |
|---|---|
| opened | green |
| merged | magenta |
| closed | red |
| reopened | yellow |
| synchronize | cyan |
| labeled | blue |
| assigned | yellow |

---

### record_poll() — the worktrace heart

```python
def record_poll(run: wt.Run, new_prs: list[dict], total_events: int) -> None:
    global poll_count
    poll_count += 1

    for pr in new_prs:
        action_counts[pr["action"]] += 1
        repo_counts[pr["repo"]] += 1

    wt.event(
        "poll.done",
        resource="github/events",
        data={"total_events": total_events, "new_prs": len(new_prs), "poll_number": poll_count},
        run=run,
    )

    for pr in new_prs:
        wt.event(
            f"pr.{pr['action']}",
            resource=f"gh/{pr['repo']}",
            data={"title": pr["title"], "user": pr["user"], "added": pr["added"], "deleted": pr["deleted"]},
            run=run,
        )

    wt.snapshot(
        resource="gh/pr-stream",
        kind="activity",
        data={
            "poll_count": poll_count,
            "total_prs_this_session": sum(action_counts.values()),
            "by_action": dict(action_counts),
            "top_repos": dict(repo_counts.most_common(10)),
        },
        run=run,
    )
```

This is where ghpool becomes more than a ticker. Three things happen per poll:

1. **`poll.done` event** — records that a poll cycle completed, how many total events came back, how many were new PRs.

2. **One `pr.<action>` event per new PR** — each PR gets its own event, tagged with the repo as resource. This means you can later query `query.events(resource="gh/torvalds/linux")` and see only Linux kernel PRs.

3. **One snapshot** — captures the full aggregate state of the session at this moment: total PRs seen, breakdown by action, top 10 most active repos. This is the time-series. Every poll adds one row to the snapshot history.

---

### Main block

```python
run = wt.start_run(
    name="ghpool",
    tags=["github", "prs"],
    metadata={"poll_interval": POLL_INTERVAL, "token": bool(TOKEN)},
)
```

Opens a worktrace run. Everything that follows — events, snapshots — is linked to this run by its ID. `metadata` records the session config so you know later how it was run.

```python
# seed phase
initial = fetch_events()
initial_prs = [parse_pr(e) for e in initial]
initial_prs = [p for p in initial_prs if p]
for e in initial:
    seen.add(e["id"])
for pr in initial_prs:
    render_pr(pr)
wt.event("session.start", data={"seeded_events": len(initial), "seeded_prs": len(initial_prs)}, run=run)
```

The seed phase shows the current state immediately on launch and marks all existing events as seen. Without this, the first poll would show up to 100 events all at once. `session.start` records in worktrace that the session began cleanly and how many events it started with.

```python
# poll loop
while True:
    time.sleep(POLL_INTERVAL)
    wt.event("poll.start", resource="github/events", run=run)
    try:
        events = fetch_events()
    except Exception as ex:
        wt.event("poll.failed", resource="github/events", data={"error": str(ex)}, run=run)
        continue

    new_prs = [parse_pr(e) for e in events if e["id"] not in seen]
    # deduplicate and record
    ...
    record_poll(run, new_prs, len(events))
    for pr in new_prs:
        render_pr(pr)
```

Every 5 seconds: emit `poll.start`, fetch, emit `poll.done` (inside `record_poll`), display new PRs. A failed fetch emits `poll.failed` with the error and `continue`s — the loop keeps running.

```python
except KeyboardInterrupt:
    wt.event("session.end", data={...}, run=run)
    wt.end_run(run, status="success")
```

Ctrl+C closes the run cleanly. `session.end` records the final totals. The run is marked `success`.

---

## Part 4 — running and testing

All commands below assume your project folder is `C:/ghpool` and you are using Git Bash or a similar Unix-style terminal on Windows. PowerShell equivalents are noted where they differ.

---

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
ghpool — live GitHub PR stream  (Ctrl+C to stop)

token loaded · 100 events fetched

09:51:23  opened  GasperX93/swarm-notify  crtahlin
  Web UI reference app with use cases and developer guidance  +3632 -0

09:51:24  merged  lightdash/lightdash  dependabot
  build(deps): bump express from 4.18.2 to 4.19.2  +3 -3

Watching for new events every 5s...
```

The first batch shows existing PRs from the current GitHub event window. After that, new PRs appear every 5 seconds as they happen globally.

**Step 4 — stop and inspect**

Press `Ctrl+C` to stop. The run is saved cleanly. Then:

```bash
# list your sessions
worktrace runs --tag github

# inspect the last session (copy the ID prefix from the runs list)
worktrace show-run <id-prefix>
```

**Step 5 — query snapshots**

```bash
python -c "
from worktrace import query
for s in query.snapshots(resource='gh/pr-stream', kind='activity'):
    print(s.timestamp[11:19], s.data['by_action'])
"
```

You will see one line per poll cycle, showing how the PR action counts evolved over the session.

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

As soon as new PR events are detected, they appear in **both** terminals simultaneously — in Terminal A as colored cards, in Terminal B as raw structured events from worktrace.

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

**Step 7 — stop both and run Python queries**

Stop ghpool in Terminal A with `Ctrl+C`. Stop the tail in Terminal B with `Ctrl+C`.

In either terminal, run the queries from Part 5 below. Examples:

```bash
# top repos across all sessions
python -c "
from worktrace import query
from collections import Counter
counts = Counter()
for s in query.snapshots(resource='gh/pr-stream', kind='activity'):
    for repo, n in s.data.get('top_repos', {}).items():
        counts[repo] += n
for repo, total in counts.most_common(10):
    print(f'{total:>6}  {repo}')
"

# all merges ever recorded
python -c "
from worktrace import query
merges = query.events(type_prefix='pr.merged')
print(len(merges), 'merges recorded')
for e in merges[:5]:
    print(' ', e.timestamp[11:19], e.resource_uri, e.data.get('title','')[:50])
"

# replay a session
python -c "
from worktrace import query
runs = query.runs(tag='github')
run_id = runs[0].id   # most recent session
events = query.events(type_prefix='pr.*', run_id=run_id)
for e in events:
    print(e.timestamp[11:19], e.type, e.resource_uri)
"
```

---

### Quick reference — all commands

| What | Command |
|---|---|
| Start ghpool | `python ghpool.py` |
| Watch all PR events live | `worktrace tail --type pr.*` |
| Watch only merges | `worktrace tail --type pr.merged` |
| Watch one repo | `worktrace tail --resource gh/owner/repo` |
| Watch poll health | `worktrace tail --type poll.*` |
| List sessions | `worktrace runs --tag github` |
| Inspect a session | `worktrace show-run <id-prefix>` |
| Only failed sessions | `worktrace runs --tag github --status failed` |
| Sessions from last hour | `worktrace runs --tag github --since -1h` |

---

## Part 5 — what you can do with the data

### Terminal — while ghpool runs

Open a second terminal, activate the venv, then:

```bash
# watch all PR events live
worktrace tail --type pr.*

# watch only merges
worktrace tail --type pr.merged

# watch one specific repo
worktrace tail --resource gh/facebook/react

# watch poll health
worktrace tail --type poll.*
```

### Terminal — after stopping

```bash
# list all ghpool sessions
worktrace runs --tag github

# inspect a full session
worktrace show-run <id-prefix>

# only failed sessions
worktrace runs --tag github --status failed
```

### Python queries

```python
from worktrace import query

# --- replay a session's PR stream ---
events = query.events(type_prefix="pr.*", run_id="<full-run-id>")
for e in events:
    repo = e.resource_uri.replace("gh/", "")
    print(f"{e.timestamp[11:19]}  {e.type:<20}  {repo:<40}  {e.data.get('title','')[:50]}")

# --- all merges ever recorded ---
merges = query.events(type_prefix="pr.merged")
print(f"{len(merges)} merges recorded across all sessions")

# --- activity on a specific repo across all sessions ---
events = query.events(resource="gh/torvalds/linux")
for e in events:
    print(e.timestamp[:19], e.type, e.data.get("title", ""))

# --- snapshot time-series: how did activity evolve? ---
for s in query.snapshots(resource="gh/pr-stream", kind="activity"):
    print(s.timestamp[11:19], s.data["by_action"])

# --- top repos across all sessions ---
from collections import Counter
counts = Counter()
for s in query.snapshots(resource="gh/pr-stream", kind="activity"):
    for repo, n in s.data.get("top_repos", {}).items():
        counts[repo] += n
for repo, total in counts.most_common(20):
    print(f"{total:>6}  {repo}")

# --- merge rate over time ---
for s in query.snapshots(resource="gh/pr-stream", kind="activity"):
    merges = s.data.get("by_action", {}).get("merged", 0)
    polls  = s.data.get("poll_count", 1)
    print(f"{s.timestamp[11:19]}  merges/poll: {merges/polls:.2f}")

# --- failed poll cycles ---
failures = query.events(type_prefix="poll.failed")
for e in failures:
    print(e.timestamp[:19], e.data.get("error"))

# --- PRs by a specific user across all sessions ---
all_prs = query.events(type_prefix="pr.*")
user_prs = [e for e in all_prs if e.data.get("user") == "dependabot"]
print(f"dependabot: {len(user_prs)} PR events recorded")
```

---

## Part 5 — what comes next (v2 ideas)

### Heatmap
Group repos by PR activity over time. Which repos are hottest right now vs an hour ago? A Rich-based grid in the terminal or a simple web page.

### Block visualization
Like mempool.space's block view — each PR is a rectangle, size proportional to lines changed, color by action. A merge wave = blocks disappearing. Built with Flask + vanilla JS reading from the worktrace snapshot history.

### Bot vs human filter
`dependabot`, `github-actions`, `renovate` account for a large share of PRs. Filter them out to see only human activity, or compare bot vs human merge rates.

### Language detection
Parse the repo name or fetch repo metadata to group PRs by language. Are Python repos merging faster than Rust repos right now?

### Alerting
Query the last N snapshots and alert (print, send a notification) when merge rate drops suddenly — could indicate a GitHub outage or a global freeze.

---

## File structure

```
ghpool/
  ghpool.py        — the script
  requirements.txt — dependencies
  PLAN.md          — original project plan
  TUTORIAL.md      — this file
  WORKTRACE.md     — worktrace integration reference
  .env             — your GitHub token (never committed)
  .gitignore       — excludes .env and .venv
  .venv/           — Python virtual environment
```

---

## Credits

- **worktrace** — [github.com/Pedro-Oub/worktrace](https://github.com/Pedro-Oub/worktrace) by Pedro-Oub. Handles all storage, querying, and the CLI.
- **GitHub Events API** — [docs.github.com/en/rest/activity/events](https://docs.github.com/en/rest/activity/events). Free, public, no special scopes needed.
