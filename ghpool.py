"""
ghpool — live GitHub PR stream with worktrace history

Polls the GitHub public Events API every 5 seconds, filters for
PullRequestEvents, displays them as a live feed, and records everything
to a local SQLite database via worktrace.

Usage:
    python ghpool.py

Requires a .env file with GITHUB_TOKEN=<your token>.
See README.md for setup instructions.
"""

import os
import time
import requests
from collections import Counter
from dotenv import load_dotenv
from rich.console import Console
import worktrace as wt

load_dotenv()

TOKEN = os.getenv("GITHUB_TOKEN")
HEADERS = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}
POLL_INTERVAL = 5  # seconds — safe with token, change to 60 without

console = Console(highlight=False)
seen: set[str] = set()              # event IDs already displayed — prevents duplicates across polls
action_counts: Counter = Counter()        # PR actions
repo_counts: Counter = Counter()          # PR repos
user_counts: Counter = Counter()          # PR users
star_counts: Counter = Counter()          # star actions
star_user_counts: Counter = Counter()     # star users
issue_action_counts: Counter = Counter()  # issue actions
issue_user_counts: Counter = Counter()    # issue users
fork_counts: Counter = Counter()          # fork actions
fork_user_counts: Counter = Counter()     # fork users
release_counts: Counter = Counter()       # release actions
release_user_counts: Counter = Counter()  # release users
poll_count = 0
session_start: float = 0.0



# ---------------------------------------------------------------------------
# GitHub API
# ---------------------------------------------------------------------------

def fetch_events() -> list[dict]:
    """Fetch the latest 100 public GitHub events."""
    r = requests.get(
        "https://api.github.com/events",
        headers={**HEADERS, "Accept": "application/vnd.github+json"},
        params={"per_page": 100},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def fetch_pr_details(url: str) -> dict:
    """Fetch the full PR object from its API URL.

    The events payload sometimes omits title, user, and line counts.
    This fills in the gaps when needed.
    """
    try:
        r = requests.get(url, headers={**HEADERS, "Accept": "application/vnd.github+json"}, timeout=8)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {}


def parse_pr(event: dict) -> dict | None:
    """Extract a clean PR dict from a raw GitHub event.

    Returns None for non-PR events or events with unrecoverable missing data.
    Falls back to fetch_pr_details() if the events payload is incomplete.
    """
    if event.get("type") != "PullRequestEvent":
        return None
    try:
        pr = event["payload"]["pull_request"]
        title = (pr.get("title") or "").strip()
        user = (pr.get("user") or {}).get("login", "")
        added = pr.get("additions")
        deleted = pr.get("deletions")

        # the events API sometimes returns incomplete payloads — fetch the full PR if needed
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
            "title": title,
            "added": added or 0,
            "deleted": deleted or 0,
            "user": user,
            "time": event["created_at"][11:19],  # HH:MM:SS from ISO timestamp
        }
    except (KeyError, TypeError):
        return None


def parse_star(event: dict) -> dict | None:
    """Extract a star event from a WatchEvent."""
    if event.get("type") != "WatchEvent":
        return None
    try:
        return {
            "id": event["id"],
            "kind": "star",
            "action": "starred",
            "repo": event["repo"]["name"],
            "title": "",
            "added": 0,
            "deleted": 0,
            "user": event["actor"]["login"],
            "time": event["created_at"][11:19],
        }
    except (KeyError, TypeError):
        return None


def parse_issue(event: dict) -> dict | None:
    """Extract an issue event from an IssuesEvent."""
    if event.get("type") != "IssuesEvent":
        return None
    try:
        issue = event["payload"]["issue"]
        return {
            "id": event["id"],
            "kind": "issue",
            "action": event["payload"].get("action", "?"),
            "repo": event["repo"]["name"],
            "title": (issue.get("title") or "").strip(),
            "added": 0,
            "deleted": 0,
            "user": (issue.get("user") or {}).get("login", "?"),
            "time": event["created_at"][11:19],
        }
    except (KeyError, TypeError):
        return None


def parse_fork(event: dict) -> dict | None:
    """Extract a fork event from a ForkEvent."""
    if event.get("type") != "ForkEvent":
        return None
    try:
        return {
            "id": event["id"],
            "kind": "fork",
            "action": "forked",
            "repo": event["repo"]["name"],
            "title": event["payload"]["forkee"]["full_name"],
            "added": 0,
            "deleted": 0,
            "user": event["actor"]["login"],
            "time": event["created_at"][11:19],
        }
    except (KeyError, TypeError):
        return None


def parse_release(event: dict) -> dict | None:
    """Extract a release event from a ReleaseEvent."""
    if event.get("type") != "ReleaseEvent":
        return None
    try:
        release = event["payload"]["release"]
        return {
            "id": event["id"],
            "kind": "release",
            "action": event["payload"].get("action", "published"),
            "repo": event["repo"]["name"],
            "title": (release.get("name") or release.get("tag_name") or "").strip(),
            "added": 0,
            "deleted": 0,
            "user": event["actor"]["login"],
            "time": event["created_at"][11:19],
        }
    except (KeyError, TypeError):
        return None


def parse_event(event: dict) -> dict | None:
    """Try to parse an event as a PR, star, issue, fork, or release."""
    return parse_pr(event) or parse_star(event) or parse_issue(event) or parse_fork(event) or parse_release(event)


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

ACTION_COLOR = {
    "opened": "green",
    "merged": "magenta",
    "closed": "red",
    "reopened": "yellow",
    "synchronize": "cyan",
    "labeled": "blue",
    "unlabeled": "blue",
    "assigned": "yellow",
    "unassigned": "yellow",
    "review_requested": "cyan",
    "review_request_removed": "cyan",
    "ready_for_review": "green",
    "converted_to_draft": "white",
}

DISPLAY_ACTION = {
    "synchronize": "pushed",
    "review_requested": "rev_req",
    "review_request_removed": "rev_req_rm",
    "ready_for_review": "ready",
    "converted_to_draft": "draft",
}


ISSUE_ACTION_COLOR = {
    "opened": "green",
    "closed": "red",
    "reopened": "yellow",
    "labeled": "blue",
    "unlabeled": "blue",
    "assigned": "yellow",
    "unassigned": "yellow",
}

KIND_PREFIX = {"pr": "PR", "star": "* ", "issue": "# ", "fork": "FK", "release": "RL"}


def render_event(ev: dict) -> None:
    """Print one event (PR, star, or issue) as a card."""
    kind = ev.get("kind", "pr")
    prefix = KIND_PREFIX.get(kind, "PR")

    if kind == "star":
        color = "yellow"
        label = "starred"
        a_count = star_counts[ev["action"]]
        u_count = star_user_counts[ev["user"]]
    elif kind == "issue":
        color = ISSUE_ACTION_COLOR.get(ev["action"], "white")
        label = ev["action"]
        a_count = issue_action_counts[ev["action"]]
        u_count = issue_user_counts[ev["user"]]
    elif kind == "fork":
        color = "blue"
        label = "forked"
        a_count = fork_counts[ev["action"]]
        u_count = fork_user_counts[ev["user"]]
    elif kind == "release":
        color = "cyan"
        label = ev["action"]
        a_count = release_counts[ev["action"]]
        u_count = release_user_counts[ev["user"]]
    else:
        color = ACTION_COLOR.get(ev["action"], "white")
        label = DISPLAY_ACTION.get(ev["action"], ev["action"])
        a_count = action_counts[ev["action"]]
        u_count = user_counts[ev["user"]]

    elapsed = time.time() - session_start
    if elapsed < 60:
        elapsed_str = f"{int(elapsed)}s"
    elif elapsed < 3600:
        elapsed_str = f"{int(elapsed / 60)}m"
    else:
        elapsed_str = f"{elapsed / 3600:.1f}h"

    user_display = ev["user"][:20]
    owner, _, repo_name = ev["repo"].partition("/")
    repo_display = f"{owner[:20]}/{repo_name[:20]}"

    console.print(f"[grey42]{ev['time']}[/grey42]  [{color}]{prefix:<3} {label} ({a_count})[/{color}] [grey42]by[/grey42] [bright_white]{user_display}[/bright_white] [grey42]({u_count}) · {elapsed_str}[/grey42]")

    if kind == "pr":
        added = f"+{ev['added'] / 1000:.1f}k" if ev["added"] >= 1000 else f"+{ev['added']}"
        deleted = f"-{ev['deleted'] / 1000:.1f}k" if ev["deleted"] >= 1000 else f"-{ev['deleted']}"
        size = f"[{added} {deleted}]"
        console.print(f"{'':10}{repo_display}  {size}")
    else:
        console.print(f"{'':10}{repo_display}")

    if ev["title"]:
        title = ev["title"][:60] + "..." if len(ev["title"]) > 60 else ev["title"]
        console.print(f"[grey42]{'':10}{title}[/grey42]")

    console.print()


# ---------------------------------------------------------------------------
# worktrace helpers
# ---------------------------------------------------------------------------

def record_poll(run: wt.Run, new_prs: list[dict], total_events: int) -> None:
    """Write one poll cycle to worktrace: a poll.done event, one pr.* event
    per new PR, and a snapshot of the full session state.

    The snapshot is what builds the queryable time-series — every poll adds
    one row, so you can later compare activity across minutes or hours.
    """
    global poll_count
    poll_count += 1

    # update session-level counters and render each event as its count increments
    for ev in new_prs:
        kind = ev.get("kind", "pr")
        if kind == "star":
            star_counts[ev["action"]] += 1
            star_user_counts[ev["user"]] += 1
        elif kind == "issue":
            issue_action_counts[ev["action"]] += 1
            issue_user_counts[ev["user"]] += 1
        elif kind == "fork":
            fork_counts[ev["action"]] += 1
            fork_user_counts[ev["user"]] += 1
        elif kind == "release":
            release_counts[ev["action"]] += 1
            release_user_counts[ev["user"]] += 1
        else:
            action_counts[ev["action"]] += 1
            repo_counts[ev["repo"]] += 1
            user_counts[ev["user"]] += 1
        render_event(ev)

    # record that this poll cycle completed
    wt.event(
        "poll.done",
        resource="github/events",
        data={
            "total_events": total_events,
            "new_prs": len(new_prs),
            "poll_number": poll_count,
        },
        run=run,
    )

    # one worktrace event per item — queryable by repo
    for ev in new_prs:
        kind = ev.get("kind", "pr")
        wt.event(
            f"{kind}.{ev['action']}",
            resource=f"gh/{ev['repo']}",
            data={"title": ev["title"], "user": ev["user"], "added": ev["added"], "deleted": ev["deleted"]},
            run=run,
        )

    # snapshot of session aggregate state — one per poll, stacks up over time
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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    console.print()
    console.print(f"[bold bright_white]ghpool — live GitHub PR stream  (Ctrl+C to stop)[/bold bright_white]\n")
    console.print("Format:")
    console.print(r"HH:MM:SS (UTC)  \[type] ACTION (count) by username (count) · elapsed")
    console.print("                owner/repo  [+added -deleted]")
    console.print("                title (60 chars)")
    console.print()
    console.print(f"Prefixes:  [white]PR[/white] pull request    [yellow]*[/yellow]  star    [white]#[/white]  issue    [blue]FK[/blue]  fork    [cyan]RL[/cyan]  release")
    console.print()
    console.print("Actions:")
    console.print("[green]opened[/green]")
    console.print("[magenta]merged[/magenta]")
    console.print("[red]closed[/red]")
    console.print("[yellow]reopened[/yellow]")
    console.print("[cyan]pushed[/cyan]")
    console.print("[blue]labeled[/blue]")
    console.print("[blue]unlabeled[/blue]")
    console.print("[yellow]assigned[/yellow]")
    console.print("[yellow]unassigned[/yellow]")
    console.print("[cyan]rev_req[/cyan]")
    console.print("[cyan]rev_req_rm[/cyan]")
    console.print("[green]ready[/green]")
    console.print("[white]draft[/white]")
    console.print("[blue]forked[/blue]")
    console.print("[cyan]published[/cyan]")
    console.print()

    session_start = time.time()

    # open a worktrace run for this session
    run = wt.start_run(
        name="ghpool",
        tags=["github", "prs"],
        metadata={"poll_interval": POLL_INTERVAL, "token": bool(TOKEN)},
    )

    # seed: fetch current events, show existing PRs, mark all as seen
    # without this, the first poll would dump up to 100 events at once
    try:
        initial = fetch_events()
        token_status = "token loaded" if TOKEN else "[red]no token — unauthenticated[/red]"
        console.print(f"{token_status} · {len(initial)} events fetched\n")
        initial_evs = [parse_event(e) for e in initial]
        initial_evs = [ev for ev in initial_evs if ev]
        for e in initial:
            seen.add(e["id"])
        for ev in initial_evs:
            kind = ev.get("kind", "pr")
            if kind == "star":
                star_counts[ev["action"]] += 1
                star_user_counts[ev["user"]] += 1
            elif kind == "issue":
                issue_action_counts[ev["action"]] += 1
                issue_user_counts[ev["user"]] += 1
            elif kind == "fork":
                fork_counts[ev["action"]] += 1
                fork_user_counts[ev["user"]] += 1
            elif kind == "release":
                release_counts[ev["action"]] += 1
                release_user_counts[ev["user"]] += 1
            else:
                action_counts[ev["action"]] += 1
                repo_counts[ev["repo"]] += 1
                user_counts[ev["user"]] += 1
            render_event(ev)
        wt.event("session.start", data={"seeded_events": len(initial), "seeded_prs": len(initial_evs)}, run=run)
        console.print(f"Watching for new events every {POLL_INTERVAL}s...\n")
    except Exception as ex:
        wt.event("session.seed_failed", data={"error": str(ex)}, run=run)
        console.print(f"[red]Failed to seed: {ex}[/red]")

    try:
        while True:
            time.sleep(POLL_INTERVAL)
            wt.event("poll.start", resource="github/events", run=run)
            try:
                events = fetch_events()
            except Exception as ex:
                wt.event("poll.failed", resource="github/events", data={"error": str(ex)}, run=run)
                console.print(f"[red]fetch error: {ex}[/red]")
                continue

            # collect only events we haven't seen before
            new_prs = []
            for e in events:
                if e["id"] in seen:
                    continue
                seen.add(e["id"])
                ev = parse_event(e)
                if ev:
                    new_prs.append(ev)

            record_poll(run, new_prs, len(events))

    except KeyboardInterrupt:
        console.print("\n[dim]stopped.[/dim]")
        # close the run cleanly with final session totals
        wt.event(
            "session.end",
            data={
                "poll_count": poll_count,
                "total_prs": sum(action_counts.values()),
                "by_action": dict(action_counts),
            },
            run=run,
        )
        wt.end_run(run, status="success")
