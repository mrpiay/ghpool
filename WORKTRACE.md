# ghpool — worktrace integration

How ghpool uses worktrace, what gets recorded, and how to query it.

---

## Overview

Every time you run `ghpool.py` it creates one **run** in worktrace. Inside that run, every poll cycle and every event (PR, star, issue, fork, release) is recorded as a structured **event**. Every poll cycle also writes a **snapshot** of the aggregate session state. Stop the script with Ctrl+C and the run closes cleanly.

Run for an hour → you have a queryable timeline of GitHub's global activity for that hour.

Pass `--no-record` to skip all worktrace writes and run as a pure live feed.

---

## What gets recorded

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

## Two-terminal setup

The best way to run ghpool is with two terminals open side by side.

**Terminal A** — the live feed:
```bash
python ghpool.py
```

**Terminal B** — tail the raw structured events as they're written:
```bash
worktrace tail                              # everything
worktrace tail --type pr.*                  # only PR events
worktrace tail --type pr.merged             # only merges
worktrace tail --type poll.*                # only poll cycles
worktrace tail --resource gh/torvalds/linux # one specific repo
```

This gives you two views of the same data: ghpool's formatted display on the left, raw structured events on the right. Useful for debugging, for watching a specific repo, or for seeing the full event detail (title, user, lines changed) that ghpool formats for display.

---

## CLI queries

```bash
# list all ghpool sessions with timestamps
worktrace runs --tag github

# inspect a full session — every poll cycle and every PR event
worktrace show-run <id-prefix>

# all events from the last 2 hours
worktrace tail --since -2h
```

---

## Python query API

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

---

## Example: replay a session's PR stream

```python
from worktrace import query

run_id = "<your-run-id>"
for e in query.events(type_prefix="pr.*", run_id=run_id):
    repo = e.resource_uri.replace("gh/", "")
    print(f"{e.timestamp[11:19]}  {e.type:<20}  {repo:<40}  {e.data.get('title','')[:50]}")
```

## Example: top repos across all sessions

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

## Example: most active users globally

```python
from worktrace import query
from collections import Counter

counts = Counter()
for e in query.events(type_prefix="pr.*"):
    counts[e.data.get("user", "?")] += 1

for user, n in counts.most_common(20):
    print(f"{n:>6}  {user}")
```

## Example: spot bots

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

## Example: largest PRs ever seen

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

## Example: merge ratio — what fraction of closed PRs were merged?

```python
from worktrace import query
from collections import Counter

actions = Counter(e.type for e in query.events(type_prefix="pr.*"))
merged = actions["pr.merged"]
closed = actions["pr.closed"]
ratio = merged / max(1, merged + closed)
print(f"merged: {merged}  closed: {closed}  ratio: {ratio:.0%}")
```

## Example: merge rate over time

```python
from worktrace import query

for s in query.snapshots(resource="gh/pr-stream", kind="activity"):
    merges = s.data.get("by_action", {}).get("merged", 0)
    polls  = s.data.get("poll_count", 1)
    print(f"{s.timestamp[11:19]}  merges/poll: {merges/polls:.2f}")
```

## Example: all PR activity on a specific repo

```python
from worktrace import query

for e in query.events(resource="gh/torvalds/linux"):
    print(f"{e.timestamp[11:19]}  {e.type}  {e.data.get('user')}  {e.data.get('title','')[:60]}")
```

---

## Data location

All data lives at `~/.worktrace/worktrace.db` — a local SQLite file.
Delete it to start fresh. No server, no account, no sync.
