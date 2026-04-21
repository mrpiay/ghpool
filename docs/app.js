// ---------------------------------------------------------------------------
// ghpool web — live feed + worktrace viewer
// ---------------------------------------------------------------------------

// --- State ---
let polling = false;
let pollTimer = null;
let seen = new Set();
let actionCounts = {};
let userCounts = {};
let starCounts = {};
let starUserCounts = {};
let issueCounts = {};
let issueUserCounts = {};
let forkCounts = {};
let forkUserCounts = {};
let releaseCounts = {};
let releaseUserCounts = {};
let sessionStart = 0;
let pollCount = 0;

let db = null; // sql.js database instance
let selectedRunId = null;
let activeQueryKey = null;

// --- DOM ---
const feed = document.getElementById("feed");
const feedStatus = document.getElementById("feed-status");
const feedControls = document.getElementById("feed-controls");
const tokenInput = document.getElementById("token-input");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnClear = document.getElementById("btn-clear");
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const viewer = document.getElementById("viewer");
const runsList = document.getElementById("runs-list");
const runDetail = document.getElementById("run-detail");
const runEvents = document.getElementById("run-events");
const sqlEditor = document.getElementById("sql-editor");
const btnRunSql = document.getElementById("btn-run-sql");
const results = document.getElementById("results");
const resultsTable = document.getElementById("results-table");
const btnCloseDb = document.getElementById("btn-close-db");

// --- Theme toggle ---
const btnTheme = document.getElementById("btn-theme");
const savedTheme = localStorage.getItem("ghpool-theme");
if (savedTheme === "dark") {
  document.documentElement.setAttribute("data-theme", "dark");
  btnTheme.textContent = "Light";
}
btnTheme.addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  if (isDark) {
    document.documentElement.removeAttribute("data-theme");
    btnTheme.textContent = "Dark";
    localStorage.setItem("ghpool-theme", "light");
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
    btnTheme.textContent = "Light";
    localStorage.setItem("ghpool-theme", "dark");
  }
});

// --- Tabs ---
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    // Show feed controls only on feed tab
    feedControls.style.display = tab.dataset.tab === "feed" ? "flex" : "none";
  });
});

// --- Constants ---
const API_URL = "https://api.github.com/events";
const POLL_INTERVAL = 5000; // 5s — same as terminal version

const ACTION_COLOR = {
  opened: "c-green",
  merged: "c-magenta",
  closed: "c-red",
  reopened: "c-yellow",
  synchronize: "c-cyan",
  labeled: "c-blue",
  unlabeled: "c-blue",
  assigned: "c-yellow",
  unassigned: "c-yellow",
  review_requested: "c-cyan",
  review_request_removed: "c-cyan",
  ready_for_review: "c-green",
  converted_to_draft: "c-white",
};

const DISPLAY_ACTION = {
  synchronize: "pushed",
  review_requested: "rev_req",
  review_request_removed: "rev_req_rm",
  ready_for_review: "ready",
  converted_to_draft: "draft",
};

const ISSUE_ACTION_COLOR = {
  opened: "c-green",
  closed: "c-red",
  reopened: "c-yellow",
  labeled: "c-blue",
  unlabeled: "c-blue",
  assigned: "c-yellow",
  unassigned: "c-yellow",
};

const KIND_PREFIX = {
  pr: "PR",
  star: "* ",
  issue: "# ",
  fork: "FK",
  release: "RL",
};

// --- Prebuilt queries ---
const PREBUILT_QUERIES = {
  "top-repos": `SELECT
  REPLACE(resource_uri, 'gh/', '') AS repo,
  COUNT(*) AS events
FROM events
WHERE type LIKE 'pr.%'
GROUP BY resource_uri
ORDER BY events DESC
LIMIT 20`,

  "top-users": `SELECT
  json_extract(data, '$.user') AS user,
  COUNT(*) AS events
FROM events
WHERE type LIKE 'pr.%'
GROUP BY user
ORDER BY events DESC
LIMIT 20`,

  "action-ratios": `SELECT
  SUM(CASE WHEN type = 'pr.opened' THEN 1 ELSE 0 END) AS opened,
  SUM(CASE WHEN type = 'pr.merged' THEN 1 ELSE 0 END) AS merged,
  SUM(CASE WHEN type = 'pr.closed' THEN 1 ELSE 0 END) AS closed,
  SUM(CASE WHEN type = 'pr.reopened' THEN 1 ELSE 0 END) AS reopened,
  ROUND(
    CAST(SUM(CASE WHEN type = 'pr.merged' THEN 1 ELSE 0 END) AS REAL) /
    MAX(1, SUM(CASE WHEN type IN ('pr.merged','pr.closed') THEN 1 ELSE 0 END)) * 100,
    1
  ) AS merge_pct,
  SUM(CASE WHEN type LIKE 'star.%' THEN 1 ELSE 0 END) AS stars,
  SUM(CASE WHEN type LIKE 'issue.%' THEN 1 ELSE 0 END) AS issues,
  SUM(CASE WHEN type LIKE 'fork.%' THEN 1 ELSE 0 END) AS forks,
  SUM(CASE WHEN type LIKE 'release.%' THEN 1 ELSE 0 END) AS releases
FROM events`,

  "bots": `SELECT
  json_extract(data, '$.user') AS user,
  COUNT(*) AS events
FROM events
WHERE type LIKE 'pr.%'
  AND (json_extract(data, '$.user') LIKE '%bot%'
    OR json_extract(data, '$.user') LIKE '%[bot]%'
    OR json_extract(data, '$.user') IN ('dependabot','renovate','github-actions'))
GROUP BY user
ORDER BY events DESC`,

  "largest-prs": `SELECT
  REPLACE(resource_uri, 'gh/', '') AS repo,
  json_extract(data, '$.title') AS title,
  json_extract(data, '$.user') AS user,
  CAST(json_extract(data, '$.added') AS INTEGER) + CAST(json_extract(data, '$.deleted') AS INTEGER) AS lines,
  json_extract(data, '$.added') AS added,
  json_extract(data, '$.deleted') AS deleted
FROM events
WHERE type LIKE 'pr.%'
ORDER BY lines DESC
LIMIT 20`,

  "activity-timeline": `SELECT
  SUBSTR(timestamp, 1, 16) AS minute,
  COUNT(*) AS events,
  SUM(CASE WHEN type LIKE 'pr.%' THEN 1 ELSE 0 END) AS prs,
  SUM(CASE WHEN type LIKE 'star.%' THEN 1 ELSE 0 END) AS stars,
  SUM(CASE WHEN type LIKE 'issue.%' THEN 1 ELSE 0 END) AS issues,
  SUM(CASE WHEN type LIKE 'fork.%' THEN 1 ELSE 0 END) AS forks,
  SUM(CASE WHEN type LIKE 'release.%' THEN 1 ELSE 0 END) AS releases
FROM events
WHERE type NOT LIKE 'poll.%' AND type NOT LIKE 'session.%'
GROUP BY minute
ORDER BY minute DESC
LIMIT 60`,

  "session-summary": `SELECT
  r.id,
  r.started_at,
  r.ended_at,
  r.status,
  ROUND((JULIANDAY(r.ended_at) - JULIANDAY(r.started_at)) * 86400) AS duration_sec,
  COUNT(e.id) AS total_events,
  SUM(CASE WHEN e.type LIKE 'pr.%' THEN 1 ELSE 0 END) AS prs,
  SUM(CASE WHEN e.type LIKE 'star.%' THEN 1 ELSE 0 END) AS stars,
  SUM(CASE WHEN e.type LIKE 'issue.%' THEN 1 ELSE 0 END) AS issues,
  SUM(CASE WHEN e.type LIKE 'fork.%' THEN 1 ELSE 0 END) AS forks,
  SUM(CASE WHEN e.type LIKE 'release.%' THEN 1 ELSE 0 END) AS releases
FROM runs r
LEFT JOIN events e ON e.run_id = r.id
GROUP BY r.id
ORDER BY r.started_at DESC`,

  "poll-health": `SELECT
  COUNT(*) AS total_polls,
  SUM(CASE WHEN CAST(json_extract(data, '$.new_prs') AS INTEGER) = 0 THEN 1 ELSE 0 END) AS empty_polls,
  SUM(CASE WHEN CAST(json_extract(data, '$.new_prs') AS INTEGER) > 0 THEN 1 ELSE 0 END) AS productive_polls,
  ROUND(
    CAST(SUM(CASE WHEN CAST(json_extract(data, '$.new_prs') AS INTEGER) > 0 THEN 1 ELSE 0 END) AS REAL) /
    MAX(1, COUNT(*)) * 100, 1
  ) AS productive_pct,
  MAX(CAST(json_extract(data, '$.new_prs') AS INTEGER)) AS max_per_poll,
  ROUND(AVG(CAST(json_extract(data, '$.new_prs') AS INTEGER)), 1) AS avg_per_poll
FROM events
WHERE type = 'poll.done'`,

  "pr-actions": `SELECT
  REPLACE(type, 'pr.', '') AS action,
  COUNT(*) AS count
FROM events
WHERE type LIKE 'pr.%'
GROUP BY type
ORDER BY count DESC`,

  "most-starred": `SELECT
  REPLACE(resource_uri, 'gh/', '') AS repo,
  COUNT(*) AS stars
FROM events
WHERE type = 'star.starred'
GROUP BY resource_uri
ORDER BY stars DESC
LIMIT 20`,

  "most-forked": `SELECT
  REPLACE(resource_uri, 'gh/', '') AS repo,
  COUNT(*) AS forks
FROM events
WHERE type = 'fork.forked'
GROUP BY resource_uri
ORDER BY forks DESC
LIMIT 20`,

  "issues-overview": `SELECT
  REPLACE(type, 'issue.', '') AS action,
  COUNT(*) AS count
FROM events
WHERE type LIKE 'issue.%'
GROUP BY type
ORDER BY count DESC`,

  "releases": `SELECT
  REPLACE(resource_uri, 'gh/', '') AS repo,
  json_extract(data, '$.title') AS release_name,
  json_extract(data, '$.user') AS user,
  timestamp
FROM events
WHERE type = 'release.published'
ORDER BY timestamp DESC
LIMIT 20`,

  "busiest-hours": `SELECT
  SUBSTR(timestamp, 12, 2) AS hour_utc,
  COUNT(*) AS events,
  SUM(CASE WHEN type LIKE 'pr.%' THEN 1 ELSE 0 END) AS prs,
  SUM(CASE WHEN type LIKE 'star.%' THEN 1 ELSE 0 END) AS stars
FROM events
WHERE type NOT LIKE 'poll.%' AND type NOT LIKE 'session.%'
GROUP BY hour_utc
ORDER BY hour_utc`,

  "repeat-users": `SELECT
  json_extract(data, '$.user') AS user,
  COUNT(*) AS events,
  COUNT(DISTINCT REPLACE(resource_uri, 'gh/', '')) AS repos,
  GROUP_CONCAT(DISTINCT REPLACE(type, 'pr.', '')) AS actions
FROM events
WHERE type LIKE 'pr.%'
GROUP BY user
HAVING events > 1
ORDER BY events DESC
LIMIT 20`,

  "hot-repos": `SELECT
  REPLACE(resource_uri, 'gh/', '') AS repo,
  COUNT(*) AS events,
  COUNT(DISTINCT type) AS event_types,
  COUNT(DISTINCT json_extract(data, '$.user')) AS unique_users
FROM events
WHERE type NOT LIKE 'poll.%' AND type NOT LIKE 'session.%'
GROUP BY resource_uri
ORDER BY events DESC
LIMIT 20`,

  "activity-rate": `SELECT
  SUBSTR(timestamp, 1, 16) AS minute,
  SUM(CASE WHEN type = 'pr.opened' THEN 1 ELSE 0 END) AS opened,
  SUM(CASE WHEN type = 'pr.merged' THEN 1 ELSE 0 END) AS merged,
  SUM(CASE WHEN type = 'pr.closed' THEN 1 ELSE 0 END) AS closed,
  SUM(CASE WHEN type LIKE 'star.%' THEN 1 ELSE 0 END) AS stars,
  SUM(CASE WHEN type LIKE 'issue.%' THEN 1 ELSE 0 END) AS issues,
  SUM(CASE WHEN type LIKE 'fork.%' THEN 1 ELSE 0 END) AS forks
FROM events
WHERE type NOT LIKE 'poll.%' AND type NOT LIKE 'session.%'
GROUP BY minute
ORDER BY minute DESC
LIMIT 60`,
};


// =========================================================================
// LIVE FEED
// =========================================================================

function inc(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
  return obj[key];
}

async function fetchPrDetails(url) {
  try {
    const token = tokenInput.value.trim();
    const headers = { Accept: "application/vnd.github+json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
  } catch (e) {}
  return {};
}

function parseEvent(event) {
  const type = event.type;
  try {
    if (type === "PullRequestEvent") {
      const pr = event.payload.pull_request;
      return {
        id: event.id,
        kind: "pr",
        action: event.payload.action || "?",
        repo: event.repo.name,
        title: (pr.title || "").trim(),
        added: pr.additions,
        deleted: pr.deletions,
        user: (pr.user && pr.user.login) || "",
        time: event.created_at.slice(11, 19),
        _prUrl: pr.url || "",
      };
    }
    if (type === "WatchEvent") {
      return {
        id: event.id,
        kind: "star",
        action: "starred",
        repo: event.repo.name,
        title: "",
        added: 0,
        deleted: 0,
        user: event.actor.login,
        time: event.created_at.slice(11, 19),
      };
    }
    if (type === "IssuesEvent") {
      const issue = event.payload.issue;
      return {
        id: event.id,
        kind: "issue",
        action: event.payload.action || "?",
        repo: event.repo.name,
        title: (issue.title || "").trim(),
        added: 0,
        deleted: 0,
        user: (issue.user && issue.user.login) || "?",
        time: event.created_at.slice(11, 19),
      };
    }
    if (type === "ForkEvent") {
      return {
        id: event.id,
        kind: "fork",
        action: "forked",
        repo: event.repo.name,
        title: event.payload.forkee.full_name,
        added: 0,
        deleted: 0,
        user: event.actor.login,
        time: event.created_at.slice(11, 19),
      };
    }
    if (type === "ReleaseEvent") {
      const release = event.payload.release;
      return {
        id: event.id,
        kind: "release",
        action: event.payload.action || "published",
        repo: event.repo.name,
        title: (release.name || release.tag_name || "").trim(),
        added: 0,
        deleted: 0,
        user: event.actor.login,
        time: event.created_at.slice(11, 19),
      };
    }
  } catch (e) {
    return null;
  }
  return null;
}

function elapsed() {
  const s = (Date.now() - sessionStart) / 1000;
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return (s / 3600).toFixed(1) + "h";
}

function buildCardHtml(ev) {
  const kind = ev.kind;
  const prefix = KIND_PREFIX[kind] || "PR";
  let color, label;

  if (kind === "star") {
    color = "c-yellow"; label = "starred";
  } else if (kind === "issue") {
    color = ISSUE_ACTION_COLOR[ev.action] || "c-white"; label = ev.action;
  } else if (kind === "fork") {
    color = "c-blue"; label = "forked";
  } else if (kind === "release") {
    color = "c-cyan"; label = ev.action;
  } else {
    color = ACTION_COLOR[ev.action] || "c-white";
    label = DISPLAY_ACTION[ev.action] || ev.action;
  }

  const el = elapsed();
  const user = ev.user.slice(0, 20);
  const [owner, repo] = ev.repo.split("/");
  const repoDisplay = (owner || "").slice(0, 20) + "/" + (repo || "").slice(0, 20);

  let html = `<span class="c-dim">${ev.time}</span>  <span class="${color}">${prefix.padEnd(3)} ${label} (${ev._aCount || 0})</span> <span class="c-dim">by</span> <span class="c-white">${esc(user)}</span> <span class="c-dim">(${ev._uCount || 0}) \u00b7 ${el}</span>\n`;

  if (kind === "pr") {
    const added = ev.added >= 1000 ? `+${(ev.added/1000).toFixed(1)}k` : `+${ev.added}`;
    const deleted = ev.deleted >= 1000 ? `-${(ev.deleted/1000).toFixed(1)}k` : `-${ev.deleted}`;
    html += `          ${esc(repoDisplay)}  [${added} ${deleted}]\n`;
  } else {
    html += `          ${esc(repoDisplay)}\n`;
  }

  if (ev.title) {
    const title = ev.title.length > 60 ? ev.title.slice(0, 60) + "..." : ev.title;
    html += `<span class="c-dim">          ${esc(title)}</span>\n`;
  }

  return html;
}

function renderFeedEvent(ev) {
  const kind = ev.kind;
  if (kind === "star") {
    ev._aCount = inc(starCounts, ev.action);
    ev._uCount = inc(starUserCounts, ev.user);
  } else if (kind === "issue") {
    ev._aCount = inc(issueCounts, ev.action);
    ev._uCount = inc(issueUserCounts, ev.user);
  } else if (kind === "fork") {
    ev._aCount = inc(forkCounts, ev.action);
    ev._uCount = inc(forkUserCounts, ev.user);
  } else if (kind === "release") {
    ev._aCount = inc(releaseCounts, ev.action);
    ev._uCount = inc(releaseUserCounts, ev.user);
  } else {
    ev._aCount = inc(actionCounts, ev.action);
    ev._uCount = inc(userCounts, ev.user);
  }

  const card = document.createElement("div");
  card.className = "event-card";
  card.innerHTML = buildCardHtml(ev);
  feed.appendChild(card);
  feed.scrollTop = feed.scrollHeight;
  return card;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function fetchEvents() {
  const token = tokenInput.value.trim();
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}?per_page=100&_t=${Date.now()}`, { headers, cache: "no-store" });

  const remaining = res.headers.get("x-ratelimit-remaining");
  const resetAt = res.headers.get("x-ratelimit-reset");

  if (res.status === 403 || res.status === 429) {
    const resetSec = resetAt ? Math.max(0, Math.ceil(Number(resetAt) - Date.now() / 1000)) : 60;
    throw new Error(`rate limited — resets in ${resetSec}s${!token ? " (add a token for 5000 req/hr)" : ""}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  if (remaining) {
    feedStatus.textContent = `${feedStatus.textContent} · ${remaining} requests left`;
  }

  return res.json();
}

async function poll() {
  try {
    const events = await fetchEvents();
    if (!Array.isArray(events)) {
      feedStatus.textContent = `error: unexpected response — ${JSON.stringify(events).slice(0, 100)}`;
      return;
    }
    let matched = 0;
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const ev = parseEvent(e);
      if (ev) {
        matched++;
        ev.added = ev.added || 0;
        ev.deleted = ev.deleted || 0;
        ev.user = ev.user || "?";
        const card = renderFeedEvent(ev);

        // Fill in missing PR details in background — renders instantly, updates later
        if (ev.kind === "pr" && (!ev.title || ev.user === "?" || !ev.added) && ev._prUrl) {
          fetchPrDetails(ev._prUrl).then(d => {
            if (!d || (!d.title && !d.user)) return;
            ev.title = ev.title || (d.title || "");
            ev.user = ev.user === "?" ? ((d.user && d.user.login) || "?") : ev.user;
            ev.added = ev.added || (d.additions || 0);
            ev.deleted = ev.deleted || (d.deletions || 0);
            card.innerHTML = buildCardHtml(ev);
          });
        }
      }
    }
    pollCount++;
    feedStatus.textContent = `poll #${pollCount} \u00b7 ${matched} new events \u00b7 ${seen.size} seen`;
  } catch (err) {
    feedStatus.textContent = `error: ${err.message}`;
  }
}

function startFeed() {
  if (polling) return;
  polling = true;
  sessionStart = Date.now();
  pollCount = 0;
  seen.clear();
  actionCounts = {};
  userCounts = {};
  starCounts = {};
  starUserCounts = {};
  issueCounts = {};
  issueUserCounts = {};
  forkCounts = {};
  forkUserCounts = {};
  releaseCounts = {};
  releaseUserCounts = {};

  btnStart.disabled = true;
  btnStop.disabled = false;
  feedStatus.textContent = "starting...";

  // Async poll loop — waits for each poll to finish before scheduling the next
  (async function loop() {
    while (polling) {
      await poll();
      if (polling) await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
  })();
}

function stopFeed() {
  polling = false;
  btnStart.disabled = false;
  btnStop.disabled = true;
  feedStatus.textContent = `stopped \u00b7 ${pollCount} polls \u00b7 ${seen.size} events seen`;
}

function clearFeed() {
  feed.innerHTML = "";
  feedStatus.textContent = "";
}

btnStart.addEventListener("click", startFeed);
btnStop.addEventListener("click", stopFeed);
btnClear.addEventListener("click", clearFeed);


// =========================================================================
// VIEWER
// =========================================================================

// --- DB path hint ---
const dbPathEl = document.getElementById("db-path");
const btnCopyPath = document.getElementById("btn-copy-path");
const dbPath = navigator.platform.startsWith("Win")
  ? "%USERPROFILE%\\.worktrace\\"
  : "~/.worktrace/";
dbPathEl.textContent = dbPath;
btnCopyPath.addEventListener("click", () => {
  navigator.clipboard.writeText(dbPath).then(() => {
    btnCopyPath.textContent = "Copied!";
    setTimeout(() => { btnCopyPath.textContent = "Copy path"; }, 1500);
  });
});

// --- Drag and drop ---
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) loadDbFile(file);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) loadDbFile(fileInput.files[0]);
});

async function loadDbFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const SQL = await initSqlJs({
      locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/${f}`,
    });
    db = new SQL.Database(new Uint8Array(buf));
    dropZone.classList.add("hidden");
    viewer.classList.remove("hidden");
    loadRuns();
  } catch (err) {
    alert("Failed to open database: " + err.message);
  }
}

btnCloseDb.addEventListener("click", () => {
  if (db) {
    db.close();
    db = null;
  }
  viewer.classList.add("hidden");
  dropZone.classList.remove("hidden");
  runsList.innerHTML = "";
  runEvents.innerHTML = "";
  runDetail.classList.add("hidden");
  results.classList.add("hidden");
  resultsTable.innerHTML = "";
  sqlEditor.value = "";
});

const eventsCount = document.getElementById("events-count");

// --- Runs ---
function loadRuns() {
  try {
    const res = db.exec("SELECT id, name, status, started_at, ended_at, tags FROM runs ORDER BY started_at DESC");
    runsList.innerHTML = "";
    if (!res.length || !res[0].values.length) {
      runsList.innerHTML = '<div class="c-dim" style="padding:8px">No sessions found</div>';
      return;
    }
    for (const row of res[0].values) {
      const [id, , status, started] = row;
      const item = document.createElement("div");
      item.className = "run-item";
      item.dataset.runId = id;

      const startStr = started ? started.slice(0, 19).replace("T", " ") : "?";
      const statusClass = status === "success" ? "success" : status === "running" ? "running" : "failed";

      item.innerHTML = `<span>${esc(startStr)} <span class="c-dim">${esc(id.slice(0, 8))}</span></span> <span class="run-status ${statusClass}">${esc(status)}</span>`;
      item.addEventListener("click", () => selectRun(id, item));
      runsList.appendChild(item);
    }
  } catch (err) {
    runsList.innerHTML = `<div class="results-error">${esc(err.message)}</div>`;
  }
}

function selectRun(runId, item) {
  // Highlight selected
  runsList.querySelectorAll(".run-item").forEach(el => el.classList.remove("selected"));
  item.classList.add("selected");
  selectedRunId = runId;
  document.getElementById("query-scope").textContent = `(session ${runId.slice(0, 8)})`;

  // Re-run active query scoped to new session
  runActiveQuery();

  // Load events for this run
  try {
    const res = db.exec(
      "SELECT timestamp, type, resource_uri, data FROM events WHERE run_id = ? ORDER BY timestamp",
      [runId]
    );
    runEvents.innerHTML = "";
    runDetail.classList.remove("hidden");

    if (!res.length || !res[0].values.length) {
      eventsCount.textContent = "(0)";
      runEvents.innerHTML = '<div class="c-dim" style="padding:8px">No events</div>';
      return;
    }

    eventsCount.textContent = `(${res[0].values.length})`;

    for (const row of res[0].values) {
      const [ts, type, resource, data] = row;
      const timeStr = ts ? ts.slice(11, 19) : "";
      const typeColor = getEventTypeColor(type);
      const resourceStr = resource ? resource.replace("gh/", "") : "";

      let dataStr = "";
      try {
        const d = JSON.parse(data || "{}");
        if (d.title) dataStr = d.title.slice(0, 50);
        else if (d.error) dataStr = d.error.slice(0, 50);
        else if (d.new_prs !== undefined) dataStr = `${d.new_prs} new`;
      } catch (e) {}

      const row_el = document.createElement("div");
      row_el.className = "run-event-row";
      row_el.innerHTML = `<span class="run-event-time">${esc(timeStr)}</span> <span class="${typeColor}">${esc(type)}</span>${resourceStr ? ` <span class="run-event-resource">${esc(resourceStr)}</span>` : ""}${dataStr ? ` <span class="run-event-data">${esc(dataStr)}</span>` : ""}`;
      runEvents.appendChild(row_el);
    }
  } catch (err) {
    runEvents.innerHTML = `<div class="results-error">${esc(err.message)}</div>`;
  }
}

function getEventTypeColor(type) {
  if (type.startsWith("pr.opened") || type.startsWith("pr.ready")) return "c-green";
  if (type.startsWith("pr.merged")) return "c-magenta";
  if (type.startsWith("pr.closed")) return "c-red";
  if (type.startsWith("pr.reopened")) return "c-yellow";
  if (type.startsWith("pr.synchronize")) return "c-cyan";
  if (type.startsWith("star.")) return "c-yellow";
  if (type.startsWith("issue.")) return "c-blue";
  if (type.startsWith("fork.")) return "c-blue";
  if (type.startsWith("release.")) return "c-cyan";
  if (type.startsWith("poll.")) return "c-dim";
  if (type.startsWith("session.")) return "c-dim";
  return "c-white";
}

// --- Prebuilt queries ---
function scopeQuery(sql) {
  if (!selectedRunId) return sql;
  // Inject run_id filter into queries that use the events or snapshots table
  // Add "AND e.run_id = ..." for joined queries, "AND run_id = ..." for simple ones
  if (sql.includes("e.run_id") || sql.includes("e.id")) {
    // Already a joined query — skip, session-summary handles its own joins
    return sql;
  }
  // For simple FROM events queries, add run_id filter after WHERE or inject WHERE
  const escaped = selectedRunId.replace(/'/g, "''");
  if (/\bFROM events\b/i.test(sql)) {
    if (/\bWHERE\b/i.test(sql)) {
      return sql.replace(/\bWHERE\b/i, `WHERE run_id = '${escaped}' AND`);
    } else {
      return sql.replace(/\bFROM events\b/i, `FROM events WHERE run_id = '${escaped}'`);
    }
  }
  if (/\bFROM snapshots\b/i.test(sql)) {
    if (/\bWHERE\b/i.test(sql)) {
      return sql.replace(/\bWHERE\b/i, `WHERE run_id = '${escaped}' AND`);
    } else {
      return sql.replace(/\bFROM snapshots\b/i, `FROM snapshots WHERE run_id = '${escaped}'`);
    }
  }
  return sql;
}

function runActiveQuery() {
  if (!activeQueryKey) return;
  const sql = PREBUILT_QUERIES[activeQueryKey];
  if (sql) {
    const scoped = scopeQuery(sql);
    sqlEditor.value = scoped;
    runSql(scoped);
  }
}

const queryDesc = document.getElementById("query-desc");

document.querySelectorAll(".btn-query").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".btn-query").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeQueryKey = btn.dataset.query;
    queryDesc.textContent = btn.dataset.desc || "";
    runActiveQuery();
  });
});

// --- SQL editor ---
btnRunSql.addEventListener("click", () => {
  runSql(sqlEditor.value.trim());
});

sqlEditor.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runSql(sqlEditor.value.trim());
  }
});

function runSql(sql) {
  if (!db || !sql) return;
  results.classList.remove("hidden");

  try {
    const res = db.exec(sql);
    if (!res.length) {
      resultsTable.innerHTML = '<div class="results-info">Query returned no results</div>';
      return;
    }

    const { columns, values } = res[0];
    let html = '<table><thead><tr>';
    for (const col of columns) {
      html += `<th>${esc(col)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const row of values) {
      html += '<tr>';
      for (const val of row) {
        const display = val === null ? '<span class="c-dim">null</span>' : esc(String(val));
        html += `<td>${display}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += `<div class="results-info">${values.length} row${values.length === 1 ? "" : "s"}</div>`;
    resultsTable.innerHTML = html;
  } catch (err) {
    resultsTable.innerHTML = `<div class="results-error">${esc(err.message)}</div>`;
  }
}