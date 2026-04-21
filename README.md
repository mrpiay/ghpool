# ghpool

A real-time feed of GitHub's global pull request stream, inspired by [mempool.space](https://mempool.space).

Every open PR across GitHub is like a transaction waiting to be confirmed. ghpool surfaces that stream live — who's opening, merging, and closing PRs right now, across every public repo on GitHub — and stores a queryable history of it using [worktrace](https://github.com/Pedro-Oub/worktrace).

```
10:03:43  merged   bartoszruta26-droid/Book-parser
  Update from task e5210d51  +592 -0

10:03:43  opened   pharo-spec/NewTools
  [Method Browser] Refactoring command migration  +61 -1

10:04:32  merged   mthines/gw-tools
  fix(shell): validate nav marker path exists before cd  +34 -3

10:04:47  opened   darylwui/plsfundme
  Add Singpass Myinfo KYC design spec  +607 -0
```

---

## What makes this different

Most GitHub PR tools show *your* PRs or *your org's* PRs. ghpool watches all of GitHub — every public repo, every language, every timezone — and builds a timeline you can query.

- **Live stream** — new PRs appear as they happen, every 5 seconds
- **Persistent history** — every session is stored in a local SQLite database via worktrace
- **Queryable** — replay any session, filter by repo, action, or user, compute merge rates over time

---

## Quick start

**1. Clone and install**

```bash
git clone https://github.com/mrpiay/ghpool.git
cd ghpool
python -m venv .venv
source .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt
```

**2. Get a GitHub token** (free, no scopes needed)

GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → no scopes → generate.

**3. Create `.env`**

```
GITHUB_TOKEN=ghp_yourtoken123abc
```

**4. Run**

```bash
python ghpool.py
```

---

## Two-terminal setup (recommended)

Terminal A — the stream:
```bash
python ghpool.py
```

Terminal B — live worktrace events:
```bash
worktrace tail --type pr.*
```

---

## Query your history

```bash
# list all sessions
worktrace runs --tag github

# inspect a session
worktrace show-run <id-prefix>
```

```python
from worktrace import query

# all merges ever recorded
query.events(type_prefix="pr.merged")

# top repos by PR activity
from collections import Counter
counts = Counter()
for s in query.snapshots(resource="gh/pr-stream", kind="activity"):
    for repo, n in s.data.get("top_repos", {}).items():
        counts[repo] += n
counts.most_common(10)
```

---

## Documentation

- [TUTORIAL.md](TUTORIAL.md) — full walkthrough: motivation, code explained line by line, all queries, terminal setup
- [WORKTRACE.md](WORKTRACE.md) — worktrace integration reference: what gets recorded and how to query it
---

## Built on

- [worktrace](https://github.com/Pedro-Oub/worktrace) by Pedro-Oub — workflow memory for Python scripts
- [GitHub Events API](https://docs.github.com/en/rest/activity/events) — public, free, no special scopes required
