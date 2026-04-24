"""Remote Commander backend — job-based Claude CLI driver.

A job starts the moment the client posts a prompt; the subprocess keeps running
on the server even if the client (iPhone Safari) goes to the background. The
client reconnects and replays the event log from wherever it left off.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent.resolve()
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
JOBS_DIR = BASE_DIR / "jobs"
JOBS_DIR.mkdir(exist_ok=True)
SESSIONS_FILE = BASE_DIR / "sessions.json"

HOME = Path.home()
ROJI = HOME / "OneDrive - 株式会社pragmateches" / "ロジ"

CLAUDE_CMD = os.environ.get(
    "REMOTE_COMMANDER_CLAUDE",
    str(HOME / "AppData" / "Roaming" / "npm" / "claude.cmd"),
)

# Workspace presets shown in the directory picker.
WORKSPACES: list[dict] = [
    {"id": "roji",     "label": "ロジ",        "icon": "▣", "path": str(ROJI)},
    {"id": "tico",     "label": "TICO",        "icon": "◈", "path": str(ROJI / "クライアントPJ" / "TICO調査")},
    {"id": "free",     "label": "FREE",        "icon": "◇", "path": str(ROJI / "クライアントPJ" / "FREE")},
    {"id": "keihi",    "label": "経費",        "icon": "¥",  "path": str(ROJI / "経費")},
    {"id": "proposal", "label": "提案",        "icon": "◆", "path": str(ROJI / "提案")},
    {"id": "personal", "label": "個人",        "icon": "●", "path": str(ROJI / "個人")},
    {"id": "member",   "label": "メンバー",    "icon": "◉", "path": str(ROJI / "会社業務" / "メンバー")},
    {"id": "gyomu",    "label": "会社業務",    "icon": "■", "path": str(ROJI / "会社業務")},
    {"id": "bgwork",   "label": "外部ワーク",  "icon": "▲", "path": str(ROJI / "外部ワーク")},
    {"id": "claude",   "label": ".claude",     "icon": "✦", "path": str(HOME / ".claude")},
    {"id": "desktop",  "label": "Desktop",     "icon": "▢", "path": str(HOME / "Desktop")},
    {"id": "downloads","label": "Downloads",   "icon": "↓", "path": str(HOME / "Downloads")},
]
DEFAULT_CWD = ROJI if ROJI.exists() else HOME

# -----------------------------------------------------------------------------
# Persistence helpers
# -----------------------------------------------------------------------------
def load_sessions() -> dict:
    if SESSIONS_FILE.exists():
        try:
            return json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def save_sessions(data: dict) -> None:
    SESSIONS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def touch_session(session_id: str, title: str | None = None, cwd: str | None = None) -> None:
    sessions = load_sessions()
    now = datetime.now().isoformat(timespec="seconds")
    entry = sessions.get(session_id, {"created": now, "title": title or "(untitled)"})
    entry["last_used"] = now
    if title and entry.get("title") in (None, "(untitled)", ""):
        entry["title"] = title[:80]
    if cwd:
        entry["cwd"] = cwd
    sessions[session_id] = entry
    save_sessions(sessions)


# -----------------------------------------------------------------------------
# Job manager
# -----------------------------------------------------------------------------
@dataclass
class Job:
    id: str
    session_id: str
    cwd: str
    title: str
    status: str = "running"  # running | done | canceled | error
    events: list[dict] = field(default_factory=list)
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    proc: Optional[asyncio.subprocess.Process] = None
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    finished_at: Optional[str] = None
    preview: str = ""

    def publish(self, ev: dict) -> None:
        ev = dict(ev, seq=len(self.events))
        self.events.append(ev)
        # incrementally persist
        with suppress(Exception):
            with (JOBS_DIR / f"{self.id}.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        for q in list(self.subscribers):
            with suppress(asyncio.QueueFull):
                q.put_nowait(ev)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "cwd": self.cwd,
            "title": self.title,
            "status": self.status,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
            "preview": self.preview[:160],
            "event_count": len(self.events),
        }


JOBS: dict[str, Job] = {}


async def run_job(job: Job, prompt: str, model: str | None, resume: bool) -> None:
    """Spawn claude CLI and stream events into the job."""
    cmd = [
        CLAUDE_CMD,
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--include-partial-messages",
    ]
    if resume:
        cmd += ["--resume", job.session_id]
    else:
        cmd += ["--session-id", job.session_id]
    if model:
        cmd += ["--model", model]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=job.cwd,
        )
    except Exception as e:
        job.status = "error"
        job.finished_at = datetime.now().isoformat(timespec="seconds")
        job.publish({"type": "error", "error": f"failed to spawn claude: {e}"})
        return

    job.proc = proc

    async def pump_stdout() -> None:
        """Parse stream-JSON that may contain embedded \\n inside text fields.
        We read into a buffer and use json.JSONDecoder.raw_decode to find each
        complete JSON object regardless of its line layout."""
        decoder = json.JSONDecoder()
        buf = ""
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(8192)
            if not chunk:
                break
            buf += chunk.decode("utf-8", errors="replace")
            while True:
                stripped = buf.lstrip()
                if not stripped:
                    buf = ""
                    break
                try:
                    obj, idx = decoder.raw_decode(stripped)
                except json.JSONDecodeError:
                    # Need more data
                    break
                lead = len(buf) - len(stripped)
                buf = buf[lead + idx:]
                # Update preview
                t = obj.get("type")
                if t == "stream_event":
                    d = obj.get("event", {}).get("delta", {})
                    if d.get("type") == "text_delta":
                        job.preview = (job.preview + d.get("text", ""))[-200:]
                elif t == "result":
                    job.preview = (obj.get("result") or job.preview)[:200]
                job.publish(obj)
        # Flush any trailing non-JSON garbage as a single raw payload
        if buf.strip():
            job.publish({"type": "raw", "text": buf.strip()[:4000]})

    async def pump_stderr() -> None:
        assert proc.stderr is not None
        async for raw in proc.stderr:
            text = raw.decode("utf-8", errors="replace").rstrip()
            if text:
                job.publish({"type": "stderr", "text": text})

    await asyncio.gather(pump_stdout(), pump_stderr())
    rc = await proc.wait()
    if job.status == "running":
        job.status = "canceled" if rc != 0 and job._cancel_flag else ("done" if rc == 0 else "error")
    job.finished_at = datetime.now().isoformat(timespec="seconds")
    job.publish({"type": "done", "exit_code": rc, "status": job.status})


# Dataclass doesn't like new attr — attach after creation helper
def _new_job(session_id: str, cwd: str, title: str) -> Job:
    j = Job(id=uuid.uuid4().hex[:12], session_id=session_id, cwd=cwd, title=title)
    j._cancel_flag = False  # type: ignore[attr-defined]
    JOBS[j.id] = j
    # persist minimal meta
    meta = {"id": j.id, "session_id": j.session_id, "cwd": j.cwd, "title": j.title, "created_at": j.created_at}
    with suppress(Exception):
        (JOBS_DIR / f"{j.id}.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return j


# -----------------------------------------------------------------------------
# FastAPI app
# -----------------------------------------------------------------------------
app = FastAPI(title="Remote Commander")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class ChatRequest(BaseModel):
    prompt: str
    session_id: Optional[str] = None
    cwd: Optional[str] = None
    model: Optional[str] = None
    image_paths: Optional[list[str]] = None


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Start a background job and return its id immediately."""
    if not req.prompt.strip() and not (req.image_paths or []):
        raise HTTPException(400, "prompt or image required")

    prompt = req.prompt
    if req.image_paths:
        for p in req.image_paths:
            prompt += f"\n\n[添付画像] {p}"

    sid = req.session_id or str(uuid.uuid4())
    resuming = bool(req.session_id)
    cwd = req.cwd or str(DEFAULT_CWD)

    job = _new_job(session_id=sid, cwd=cwd, title=req.prompt[:80] or "(image)")
    touch_session(sid, title=req.prompt[:80] if not resuming else None, cwd=cwd)

    # kick off the job but don't await it
    asyncio.create_task(run_job(job, prompt, req.model, resume=resuming))

    return {"job_id": job.id, "session_id": sid, "cwd": cwd}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str, since: int = 0):
    """SSE stream of job events. `since` replays from that event index."""
    job = JOBS.get(job_id)
    if not job:
        # Try to rehydrate from disk (server restart case)
        jsonl = JOBS_DIR / f"{job_id}.jsonl"
        meta = JOBS_DIR / f"{job_id}.meta.json"
        if not jsonl.exists() or not meta.exists():
            raise HTTPException(404, "job not found")
        meta_obj = json.loads(meta.read_text(encoding="utf-8"))
        # Replay-only stub (cannot resume subprocess output)
        async def replay_only():
            yield f"data: {json.dumps({'type':'job_meta', **meta_obj})}\n\n"
            with jsonl.open("r", encoding="utf-8") as f:
                for i, line in enumerate(f):
                    if i < since:
                        continue
                    yield f"data: {line.strip()}\n\n"
            yield f"data: {json.dumps({'type':'done', 'status':'replayed'})}\n\n"
        return StreamingResponse(replay_only(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

    queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
    # Capture current backlog atomically, then subscribe
    backlog = list(job.events[since:])
    job.subscribers.add(queue)

    async def stream():
        try:
            # job meta first so client knows what it reconnected to
            yield f"data: {json.dumps({'type': 'job_meta', **job.summary()}, ensure_ascii=False)}\n\n"
            for ev in backlog:
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            # if job already finished and backlog covered it, stop
            if job.status != "running" and backlog and backlog[-1].get("type") == "done":
                return
            while True:
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=25.0)
                except asyncio.TimeoutError:
                    # heartbeat so Safari/mobile Edge don't cut the connection
                    yield ": ping\n\n"
                    continue
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                if ev.get("type") == "done":
                    return
        finally:
            job.subscribers.discard(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job.status != "running":
        return {"ok": True, "status": job.status}
    job._cancel_flag = True  # type: ignore[attr-defined]
    if job.proc and job.proc.returncode is None:
        with suppress(ProcessLookupError, OSError):
            job.proc.terminate()
            # give it a moment; force kill on Windows if needed
            try:
                await asyncio.wait_for(job.proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                with suppress(Exception):
                    job.proc.kill()
    job.status = "canceled"
    return {"ok": True, "status": "canceled"}


@app.get("/api/jobs")
def list_jobs(limit: int = 30):
    items = sorted(
        (j.summary() for j in JOBS.values()),
        key=lambda x: x.get("created_at", ""),
        reverse=True,
    )
    return {"jobs": items[:limit]}


@app.get("/api/jobs/{job_id}")
def job_detail(job_id: str):
    job = JOBS.get(job_id)
    if job:
        return {**job.summary(), "events": job.events}
    # Try disk
    jsonl = JOBS_DIR / f"{job_id}.jsonl"
    meta = JOBS_DIR / f"{job_id}.meta.json"
    if jsonl.exists() and meta.exists():
        events = []
        with jsonl.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return {**json.loads(meta.read_text(encoding="utf-8")), "events": events, "status": "archived"}
    raise HTTPException(404, "job not found")


@app.get("/api/sessions")
def list_sessions():
    sessions = load_sessions()
    items = [{"id": sid, **meta} for sid, meta in sessions.items()]
    items.sort(key=lambda x: x.get("last_used", ""), reverse=True)
    return {"sessions": items}


@app.delete("/api/sessions/{sid}")
def delete_session(sid: str):
    sessions = load_sessions()
    if sid in sessions:
        del sessions[sid]
        save_sessions(sessions)
        return {"ok": True}
    raise HTTPException(404, "session not found")


@app.get("/api/skills")
def list_skills():
    """Scan ~/.claude/skills and plugin caches; return [{name, description, source}]."""
    candidates: list[Path] = []
    user_skills = HOME / ".claude" / "skills"
    if user_skills.exists():
        candidates += [(d, "user") for d in user_skills.iterdir() if d.is_dir()]
    plugin_cache = HOME / ".claude" / "plugins" / "cache"
    if plugin_cache.exists():
        for marketplace in plugin_cache.iterdir():
            if not marketplace.is_dir():
                continue
            for plugin in marketplace.iterdir():
                sk_dir = plugin / "unknown" / "skills"
                if not sk_dir.exists():
                    sk_dir = plugin / "skills"
                if sk_dir.exists():
                    candidates += [(d, f"plugin:{plugin.name}") for d in sk_dir.iterdir() if d.is_dir()]

    items: list[dict] = []
    seen: set[str] = set()
    for d, source in candidates:
        skill_md = d / "SKILL.md"
        if not skill_md.exists():
            continue
        name = d.name
        if name in seen:
            continue
        description = ""
        try:
            content = skill_md.read_text(encoding="utf-8", errors="replace")
            if content.startswith("---"):
                end = content.find("\n---", 4)
                if end > 0:
                    fm = content[3:end]
                    for line in fm.split("\n"):
                        s = line.strip()
                        if s.startswith("name:"):
                            val = s[5:].strip().strip('"').strip("'")
                            if val:
                                name = val
                        elif s.startswith("description:"):
                            description = s[12:].strip().strip('"').strip("'")
        except Exception:
            pass
        seen.add(name)
        items.append({"name": name, "description": description[:220], "source": source})

    items.sort(key=lambda x: x["name"].lower())
    return {"skills": items, "count": len(items)}


@app.get("/api/workspaces")
def list_workspaces():
    # surface existence flag so the UI can dim missing dirs
    out = []
    for w in WORKSPACES:
        out.append({**w, "exists": Path(w["path"]).exists()})
    return {"workspaces": out, "default": str(DEFAULT_CWD)}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "upload.bin").suffix or ".png"
    fname = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}{ext}"
    fpath = UPLOAD_DIR / fname
    fpath.write_bytes(await file.read())
    return {"path": str(fpath), "url": f"/uploads/{fname}", "name": fname}


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "claude": CLAUDE_CMD,
        "default_cwd": str(DEFAULT_CWD),
        "active_jobs": sum(1 for j in JOBS.values() if j.status == "running"),
        "total_jobs": len(JOBS),
        "time": datetime.now().isoformat(timespec="seconds"),
    }


app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/", StaticFiles(directory=str(BASE_DIR / "static"), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run("server:app", host=os.environ.get("HOST", "0.0.0.0"), port=port, log_level="info")
