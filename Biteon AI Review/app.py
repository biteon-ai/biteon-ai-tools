"""Qwen review UI. Talks only to Ollama on this machine."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

HOME_ROOT = Path(os.environ.get("HOME_ROOT", "/home")).resolve()
HOME_DISPLAY = os.environ.get("HOME_DISPLAY", "/home").rstrip("/")
OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434/v1").rstrip("/")
OLLAMA_ROOT = os.environ.get("OLLAMA_ROOT", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("MODEL", "qwen:security-audit")
BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
BIND_PORT = os.environ.get("BIND_PORT", "8787")
STATIC = Path(__file__).resolve().parent / "static"

SKILL_ROOTS = [
    ("bundled", "Qwen skills", Path("/skills/bundled")),
    ("extra", "Your skills", Path("/skills/extra")),
]

SKIP_DIRS = {
    "node_modules",
    ".git",
    ".next",
    "dist",
    "coverage",
    "graphify-out",
    ".security-audit",
    "playwright-report",
    "test-results",
}
SOURCE_EXT = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
    ".go", ".rs", ".java", ".php", ".rb", ".sql", ".vue",
}
MAX_FOLDER_FILES = 8
MAX_FILE_CHARS = 100_000
MAX_SKILL_CHARS = 12_000

run_lock = asyncio.Lock()
pull_lock = asyncio.Lock()
skip_current = asyncio.Event()
stop_run = asyncio.Event()
active_proc = {"proc": None}

async def list_models() -> list[str]:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            tags = await client.get(OLLAMA_ROOT + "/api/tags")
        if tags.status_code != 200:
            return []
        return [item.get("name", "") for item in tags.json().get("models", []) if item.get("name")]
    except httpx.HTTPError:
        return []


active_model = {"name": MODEL}


async def resolve_model(requested: str | None) -> str:
    names = await list_models()
    if requested and requested in names:
        active_model["name"] = requested
        return requested
    if active_model["name"] in names:
        return active_model["name"]
    if MODEL in names:
        active_model["name"] = MODEL
        return MODEL
    if names:
        active_model["name"] = names[0]
        return names[0]
    raise HTTPException(400, "No Ollama models are installed")


app = FastAPI(title="Biteon AI Review")


def to_display(path: Path) -> str:
    path = path.resolve()
    if path == HOME_ROOT:
        return HOME_DISPLAY
    rel = path.relative_to(HOME_ROOT)
    return f"{HOME_DISPLAY}/{rel.as_posix()}"


def from_display(display: str) -> Path:
    raw = (display or HOME_DISPLAY).strip().rstrip("/") or HOME_DISPLAY
    if raw != HOME_DISPLAY and not raw.startswith(HOME_DISPLAY + "/"):
        raise HTTPException(400, "Path must stay under /home")
    rel = "" if raw == HOME_DISPLAY else raw[len(HOME_DISPLAY) + 1 :]
    if rel.startswith("/") or ".." in Path(rel).parts:
        raise HTTPException(400, "Path must stay under /home")
    candidate = (HOME_ROOT / rel).resolve()
    if candidate != HOME_ROOT and HOME_ROOT not in candidate.parents:
        raise HTTPException(400, "Path must stay under /home")
    return candidate


def is_secret(path: Path) -> bool:
    name = path.name
    if name == ".env" or name.startswith(".env."):
        return True
    if name in {"id_rsa", "id_ed25519", "credentials.json", "service-account.json"}:
        return True
    return path.suffix.lower() in {".pem", ".key", ".p12"}


def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    raw = text[3:end]
    body = text[end + 4 :].lstrip("\n")
    data: dict[str, str] = {}
    lines = raw.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line or line.startswith((" ", "\t")):
            i += 1
            continue
        key, val = line.split(":", 1)
        key = key.strip()
        val = val.strip()
        if val in {">-", ">", "|", "|-"}:
            i += 1
            parts = []
            while i < len(lines) and (lines[i].startswith((" ", "\t")) or lines[i].strip() == ""):
                if lines[i].strip():
                    parts.append(lines[i].strip())
                i += 1
            data[key] = " ".join(parts)
            continue
        data[key] = val.strip("\"'")
        i += 1
    return data, body


def load_skills() -> list[dict]:
    skills = []
    for key, label, root in SKILL_ROOTS:
        if not root.is_dir():
            continue
        for skill_md in sorted(root.glob("*/SKILL.md")):
            try:
                text = skill_md.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            meta, body = parse_frontmatter(text)
            folder = skill_md.parent
            audit = folder / "scripts" / "audit.py"
            skill_id = f"{key}:{meta.get('name') or folder.name}"
            command = None
            if audit.is_file():
                command = "python3 scripts/audit.py <file>"
            skills.append(
                {
                    "id": skill_id,
                    "name": meta.get("name") or folder.name,
                    "description": meta.get("description") or "",
                    "source": label,
                    "source_key": key,
                    "folder": folder.name,
                    "command": command,
                    "runnable": command is not None,
                    "body": body[:MAX_SKILL_CHARS],
                    "script": str(audit) if audit.is_file() else None,
                }
            )
    skills.sort(key=lambda item: (not item["runnable"], item["source"], item["name"]))
    return skills


def skill_by_id(skill_id: str) -> dict:
    for skill in load_skills():
        if skill["id"] == skill_id:
            return skill
    raise HTTPException(404, "Skill is not installed")


def folder_sources(directory: Path) -> tuple[list[Path], int]:
    found: list[Path] = []
    total = 0
    for dirpath, dirs, files in os.walk(directory):
        dirs[:] = [name for name in dirs if name not in SKIP_DIRS and not name.startswith(".")]
        for name in files:
            path = Path(dirpath) / name
            if path.suffix.lower() not in SOURCE_EXT or is_secret(path):
                continue
            total += 1
            if len(found) < MAX_FOLDER_FILES:
                found.append(path)
    return found, total


def review_targets(path: Path) -> tuple[list[Path], int, str]:
    if path.is_file():
        if is_secret(path):
            raise HTTPException(400, "Secret files are not sent to the model")
        return [path], 1, "file"
    if path.is_dir():
        files, total = folder_sources(path)
        if not files:
            raise HTTPException(400, "That folder has no reviewable source files")
        return files, total, "folder"
    raise HTTPException(404, "Path does not exist")


def read_source(path: Path) -> str:
    if is_secret(path):
        raise HTTPException(400, "Secret files are not sent to the model")
    data = path.read_bytes()[: MAX_FILE_CHARS * 4]
    if b"\x00" in data:
        raise HTTPException(400, "That file is binary")
    text = data.decode("utf-8", errors="replace")
    if len(text) > MAX_FILE_CHARS:
        return text[:MAX_FILE_CHARS] + "\n\n/* truncated for review */\n"
    return text


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


class ChatIn(BaseModel):
    messages: list[dict] = Field(default_factory=list)
    path: str | None = None
    skill_id: str | None = None
    model: str | None = None


class RunIn(BaseModel):
    skill_id: str
    path: str
    allow: bool = False
    model: str | None = None


class SkillIn(BaseModel):
    name: str
    description: str = ""
    instructions: str


class ModelPullIn(BaseModel):
    name: str


EXTRA_ROOT = Path("/skills/extra")


def skill_slug(name: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in name.strip())
    while "--" in slug:
        slug = slug.replace("--", "-")
    slug = slug.strip("-")
    if len(slug) < 2 or len(slug) > 40:
        raise HTTPException(400, "Use a name with 2 to 40 letters or numbers")
    return slug


def valid_model_name(name: str) -> bool:
    if not name or len(name) > 128 or ".." in name or name.startswith(("/", ":")):
        return False
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/-")
    return all(ch in allowed for ch in name)


class ModelIn(BaseModel):
    model: str


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def health():
    names = await list_models()
    chosen = active_model["name"] if active_model["name"] in names else (MODEL if MODEL in names else (names[0] if names else MODEL))
    active_model["name"] = chosen
    ollama = False
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            root = await client.get(OLLAMA_ROOT + "/")
            ollama = root.status_code == 200
    except httpx.HTTPError:
        ollama = False
    return {
        "ollama": ollama,
        "model": chosen,
        "models": names,
        "model_present": chosen in names,
        "home": HOME_DISPLAY,
        "bind": f"{BIND_HOST}:{BIND_PORT}",
    }


@app.post("/api/model")
async def set_model(body: ModelIn):
    chosen = await resolve_model(body.model)
    return {"model": chosen}


@app.get("/api/files")
def files(path: str = HOME_DISPLAY):
    target = from_display(path)
    if not target.exists():
        raise HTTPException(404, "Path does not exist")
    if target.is_file():
        return {"path": to_display(target), "type": "file", "entries": []}
    entries = []
    try:
        children = sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
    except OSError as error:
        raise HTTPException(400, str(error)) from error
    for child in children:
        if child.name in SKIP_DIRS:
            kind = "skipped"
        elif child.is_dir():
            kind = "dir"
        elif child.is_file():
            kind = "file"
        else:
            continue
        entries.append(
            {
                "name": child.name,
                "type": kind,
                "path": to_display(child),
                "secret": child.is_file() and is_secret(child),
            }
        )
    return {"path": to_display(target), "type": "dir", "entries": entries}


@app.get("/api/file")
def file_preview(path: str):
    target = from_display(path)
    if not target.is_file():
        raise HTTPException(404, "File does not exist")
    if is_secret(target):
        raise HTTPException(400, "Secret files stay out of the preview")
    try:
        text = read_source(target)
    except HTTPException:
        raise
    except OSError as error:
        raise HTTPException(400, str(error)) from error
    return {"path": to_display(target), "text": text}


@app.get("/api/skills")
def skills():
    listed = load_skills()
    return {
        "skills": [
            {
                "id": item["id"],
                "name": item["name"],
                "description": item["description"],
                "source": item["source"],
                "command": item["command"],
                "runnable": item["runnable"],
                "owned": item["source_key"] == "extra",
            }
            for item in listed
        ]
    }


@app.get("/api/plan")
def plan(skill_id: str, path: str):
    skill = skill_by_id(skill_id)
    target = from_display(path)
    files, total, kind = review_targets(target)
    mode = "command" if skill["runnable"] else "chat"
    return {
        "mode": mode,
        "skill": skill["name"],
        "command": skill["command"] or "Follow this skill with the selected model",
        "path": to_display(target),
        "kind": kind,
        "files": [to_display(item) for item in files],
        "total": total,
        "omitted": max(0, total - len(files)),
    }


async def stream_ollama(messages: list[dict], model: str):
    body = {
        "model": model,
        "temperature": 0.1,
        "stream": True,
        "messages": messages,
    }
    timeout = httpx.Timeout(connect=10, read=None, write=30, pool=10)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            OLLAMA_BASE + "/chat/completions",
            headers={"Authorization": "Bearer ollama", "Content-Type": "application/json"},
            json=body,
        ) as response:
            if response.status_code != 200:
                detail = (await response.aread()).decode("utf-8", errors="replace")[:500]
                yield sse({"error": f"Ollama returned {response.status_code}: {detail}"})
                return
            async for line in response.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choice = (payload.get("choices") or [{}])[0]
                delta = (choice.get("delta") or {}).get("content") or ""
                if delta:
                    yield sse({"token": delta})
                if choice.get("finish_reason"):
                    break
    yield sse({"done": True})


def chat_messages(body: ChatIn, model: str | None = None) -> list[dict]:
    skill = skill_by_id(body.skill_id) if body.skill_id else None
    model_name = model or active_model["name"] or MODEL
    system = (
        f"You are {model_name} running on this machine. "
        "Review only the code you are given. Stay on this machine. "
        "Report real issues. Do not invent findings. Do not provide exploit payloads."
    )
    if skill:
        system += "\n\nFollow this installed skill:\n" + skill["body"][:6000]
    if body.path:
        target = from_display(body.path)
        if target.is_dir():
            files, total = folder_sources(target)
            names = "\n".join(to_display(item) for item in files) or "(no source files)"
            system += f"\n\nSelected folder {to_display(target)}. Source files:\n{names}"
            if total > len(files):
                system += f"\n{total - len(files)} more source files are not listed."
        elif target.is_file():
            if is_secret(target):
                raise HTTPException(400, "Secret files are not sent to the model")
            system += f"\n\nSelected file {to_display(target)}:\n```\n{read_source(target)[:8000]}\n```"
        else:
            raise HTTPException(404, "Path does not exist")
    cleaned = []
    for message in body.messages[-12:]:
        role = message.get("role")
        content = message.get("content")
        if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
            cleaned.append({"role": role, "content": content[:20_000]})
    if not cleaned or cleaned[-1]["role"] != "user":
        raise HTTPException(400, "Send a message to Qwen")
    return [{"role": "system", "content": system}, *cleaned]


@app.post("/api/chat")
async def chat(body: ChatIn):
    model = await resolve_model(body.model)
    messages = chat_messages(body, model)

    async def generate():
        if run_lock.locked():
            yield sse({"error": "A review is already running"})
            return
        await run_lock.acquire()
        try:
            async for chunk in stream_ollama(messages, model):
                yield chunk
        except httpx.HTTPError as error:
            yield sse({"error": f"Ollama is not reachable: {error}"})
        finally:
            run_lock.release()

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


async def stream_audit(script: str, files: list[Path], model: str):
    total = len(files)
    for index, target in enumerate(files, start=1):
        display = to_display(target)
        yield sse({"progress": {"index": index, "total": total, "file": display, "phase": "running"}})
        process = await asyncio.create_subprocess_exec(
            "python3",
            "-u",
            script,
            "--base-url",
            OLLAMA_BASE,
            "--model",
            model,
            str(target),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        assert process.stdout is not None
        queue: asyncio.Queue = asyncio.Queue()

        async def read_stdout(stdout, sink: asyncio.Queue):
            try:
                while True:
                    line = await stdout.readline()
                    if not line:
                        await sink.put(None)
                        return
                    await sink.put(line)
            except asyncio.CancelledError:
                raise

        reader = asyncio.create_task(read_stdout(process.stdout, queue))
        active_proc["proc"] = process
        skipped = False
        code = 0
        try:
            while True:
                if skip_current.is_set():
                    skipped = True
                    break
                item_task = asyncio.create_task(queue.get())
                skip_task = asyncio.create_task(skip_current.wait())
                stop_task = asyncio.create_task(stop_run.wait())
                done, pending = await asyncio.wait({item_task, skip_task, stop_task}, timeout=2, return_when=asyncio.FIRST_COMPLETED)
                for pending_task in pending:
                    pending_task.cancel()
                if stop_run.is_set():
                    break
                if skip_current.is_set():
                    skipped = True
                    break
                if item_task not in done:
                    yield sse({"pulse": True, "index": index, "total": total, "file": display})
                    continue
                item = item_task.result()
                if item is None:
                    break
                yield sse({"line": item.decode("utf-8", errors="replace").rstrip("\n")})
            if stop_run.is_set():
                stop_run.clear()
                reader.cancel()
                if process.returncode is None:
                    process.kill()
                await process.wait()
                active_proc["proc"] = None
                yield sse({"status": "Stopped", "done": True})
                return
            if skipped:
                skip_current.clear()
                reader.cancel()
                if process.returncode is None:
                    process.kill()
                await process.wait()
                yield sse({"status": "Skipped " + display, "progress": {"index": index, "total": total, "file": display, "phase": "skipped"}})
                continue
            code = await process.wait()
        except asyncio.CancelledError:
            reader.cancel()
            if process.returncode is None:
                process.kill()
            raise
        finally:
            if not reader.done():
                reader.cancel()
        yield sse({"progress": {"index": index, "total": total, "file": display, "phase": "done", "code": code}})
        if code != 0:
            yield sse({"error": f"Audit command failed for {display}"})
            return
    yield sse({"done": True, "progress": {"index": total, "total": total, "file": "", "phase": "finished"}})


async def stream_skill_chat(skill: dict, files: list[Path], model: str):
    total = len(files)
    instructions = (skill.get("body") or "").strip()[:6000]
    for index, target in enumerate(files, start=1):
        if stop_run.is_set():
            stop_run.clear()
            yield sse({"status": "Stopped"})
            return
        display = to_display(target)
        yield sse({"progress": {"index": index, "total": total, "file": display, "phase": "running"}})
        source = read_source(target)
        clipped = source[:8000]
        note = ""
        if len(source) > len(clipped):
            note = " The file was shortened to fit the model."
        messages = [
            {
                "role": "system",
                "content": (
                    f"You are {model} running on this machine. "
                    "Follow the skill below. Use only the file you are given. "
                    "Do not invent issues. Do not provide exploit payloads.\n\n"
                    + instructions
                ),
            },
            {
                "role": "user",
                "content": f"Apply this skill to {display}.{note}\n\n```\n{clipped}\n```",
            },
        ]
        async for chunk in stream_ollama(messages, model):
            if stop_run.is_set():
                stop_run.clear()
                yield sse({"status": "Stopped"})
                return
            if skip_current.is_set():
                skip_current.clear()
                yield sse({"status": f"Skipped {display}"})
                break
            yield chunk
        yield sse({"progress": {"index": index, "total": total, "file": display, "phase": "done"}})
    yield sse({"done": True, "progress": {"index": total, "total": total, "file": "", "phase": "finished"}})


@app.post("/api/skills")
def create_skill(body: SkillIn):
    name = body.name.strip()
    instructions = body.instructions.strip()
    description = " ".join(body.description.split())[:400]
    if len(name) < 2 or len(name) > 60:
        raise HTTPException(400, "Name must be 2 to 60 characters")
    if len(instructions) < 10 or len(instructions) > MAX_SKILL_CHARS:
        raise HTTPException(400, "Instructions must be 10 to 12000 characters")
    slug = skill_slug(name)
    EXTRA_ROOT.mkdir(parents=True, exist_ok=True)
    folder = (EXTRA_ROOT / slug).resolve()
    if EXTRA_ROOT.resolve() not in folder.parents:
        raise HTTPException(400, "Invalid skill name")
    if folder.exists():
        raise HTTPException(409, "A skill with that name already exists")
    folder.mkdir()
    safe_desc = description.replace("---", " ").strip() or f"Custom skill for the selected model: {slug}"
    (folder / "SKILL.md").write_text(
        f"---\nname: {slug}\ndescription: {safe_desc}\n---\n\n{instructions}\n",
        encoding="utf-8",
    )
    return {"id": f"extra:{slug}", "name": slug}


@app.delete("/api/skills/{skill_id:path}")
def delete_skill(skill_id: str):
    skill = skill_by_id(skill_id)
    if skill["source_key"] != "extra":
        raise HTTPException(400, "Only skills you added can be removed")
    folder = (EXTRA_ROOT / skill["folder"]).resolve()
    if EXTRA_ROOT.resolve() not in folder.parents or not folder.is_dir():
        raise HTTPException(400, "Skill folder is not removable")
    for child in sorted(folder.rglob("*"), reverse=True):
        if child.is_file() or child.is_symlink():
            child.unlink()
        elif child.is_dir():
            child.rmdir()
    folder.rmdir()
    return {"ok": True}


@app.post("/api/models/pull")
async def pull_model(body: ModelPullIn):
    name = body.name.strip()
    if not valid_model_name(name):
        raise HTTPException(400, "Enter an Ollama model name such as qwen2.5-coder:7b")

    async def generate():
        if pull_lock.locked() or run_lock.locked():
            yield sse({"error": "Wait until the current review or install finishes"})
            return
        await pull_lock.acquire()
        try:
            timeout = httpx.Timeout(connect=10, read=None, write=30, pool=10)
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", OLLAMA_ROOT + "/api/pull", json={"name": name, "stream": True}) as response:
                    if response.status_code != 200:
                        detail = (await response.aread()).decode("utf-8", errors="replace")[:400]
                        yield sse({"error": detail or f"Ollama returned {response.status_code}"})
                        return
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            payload = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if payload.get("error"):
                            yield sse({"error": str(payload["error"])})
                            return
                        total = payload.get("total") or 0
                        completed = payload.get("completed") or 0
                        percent = int(completed * 100 / total) if total else None
                        yield sse({"status": payload.get("status") or "working", "percent": percent})
            names = await list_models()
            chosen = name if name in names else active_model["name"]
            if name in names:
                active_model["name"] = name
            yield sse({"done": True, "models": names, "model": chosen})
        except httpx.HTTPError as error:
            yield sse({"error": f"Ollama is not reachable: {error}"})
        finally:
            if pull_lock.locked():
                pull_lock.release()

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


@app.post("/api/run")
async def run(body: RunIn):
    if not body.allow:
        raise HTTPException(400, "Allow the run before it starts")
    skill = skill_by_id(body.skill_id)
    target = from_display(body.path)
    files, _total, _kind = review_targets(target)
    model = await resolve_model(body.model)

    async def generate():
        if run_lock.locked():
            yield sse({"error": "A review is already running"})
            return
        await run_lock.acquire()
        skip_current.clear()
        stop_run.clear()
        try:
            if skill["runnable"] and skill["script"]:
                async for chunk in stream_audit(skill["script"], files, model):
                    yield chunk
                return
            async for chunk in stream_skill_chat(skill, files, model):
                yield chunk
        except httpx.HTTPError as error:
            yield sse({"error": f"Ollama is not reachable: {error}"})
        finally:
            run_lock.release()

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

class ExportIn(BaseModel):
    path: str
    skill: str = "review"
    text: str


@app.post("/api/export")
def export_report(body: ExportIn):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "There is no report to save")
    if len(text) > 2_000_000:
        raise HTTPException(400, "Report is too large")
    target = from_display(body.path or HOME_DISPLAY)
    folder = target if target.is_dir() else target.parent
    if not folder.is_dir():
        raise HTTPException(400, "Project folder does not exist")
    out_dir = (folder / "qwen-reviews").resolve()
    if out_dir != HOME_ROOT and HOME_ROOT not in out_dir.parents:
        raise HTTPException(400, "Path must stay under /home")
    out_dir.mkdir(exist_ok=True)
    slug = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in body.skill.lower()).strip("-")[:40] or "review"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = out_dir / f"{stamp}-{slug}.md"
    display_target = to_display(target)
    dest.write_text(
        f"# Biteon AI Review report\n\nSkill: {body.skill}\nPath: {display_target}\nSaved: {stamp} UTC\n\n{text}\n",
        encoding="utf-8",
    )
    return {"path": to_display(dest)}


@app.post("/api/skip")
async def skip_file():
    skip_current.set()
    return {"ok": True}


@app.post("/api/stop")
async def stop_review():
    stop_run.set()
    proc = active_proc.get("proc")
    if proc is not None and proc.returncode is None:
        proc.kill()
    return {"ok": True}
