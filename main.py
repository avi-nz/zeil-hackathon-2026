"""ZEIL Evidence Interview MVP server.

Recruiter:  job title + description + competencies --Gemini--> role-specific scenarios + evidence rubrics
Candidate:  per scenario, audio --Gemini--> transcript --Jev--> evidence status --Gemini--> targeted follow-up
Run:  .venv/bin/python main.py   then open http://localhost:8000 (candidate) or /recruiter.html
"""
import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import gemini
import jev
from rubric import DEFAULT_JOB, FAIRNESS_PAIR, MAX_COMPETENCIES, MAX_PROBES_PER_DIM, max_answers

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
JOBS_FILE = ROOT / "data" / "jobs.json"

app = FastAPI(title="ZEIL Evidence Interview")
# Lets the page work when opened from an IDE preview server (e.g. PyCharm on :63342) as well as from :8000.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(requests.RequestException)
def upstream_error(_request, exc):
    return JSONResponse(status_code=502, content={"detail": f"AI service error, please try again ({exc})"})


# ---------- Jobs (recruiter side) ----------

def _saved_jobs() -> dict[str, dict]:
    return json.loads(JOBS_FILE.read_text()) if JOBS_FILE.exists() else {}


def _get_job(job_id: str) -> dict:
    job = {DEFAULT_JOB["id"]: DEFAULT_JOB, **_saved_jobs()}.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return job


class GenerateRequest(BaseModel):
    title: str
    description: str = ""
    competencies: list[str] = []


class SaveRequest(BaseModel):
    title: str
    description: str = ""
    competencies: list[dict]


@app.get("/api/jobs")
def list_jobs():
    jobs = sorted(_saved_jobs().values(), key=lambda j: j.get("created", 0), reverse=True) + [DEFAULT_JOB]
    return [{"id": j["id"], "title": j["title"], "competencies": [c["name"] for c in j["competencies"]]}
            for j in jobs]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return _get_job(job_id)


@app.post("/api/jobs/generate")
def generate(req: GenerateRequest):
    title = req.title.strip()
    if not title:
        raise HTTPException(422, "Job title is required")
    competencies = [c.strip() for c in req.competencies if c.strip()]
    return {"title": title, "description": req.description.strip(),
            "competencies": gemini.generate_job(title, req.description.strip(), competencies)}


@app.post("/api/jobs")
def save(req: SaveRequest):
    competencies, seen = [], set()
    for c in req.competencies[:MAX_COMPETENCIES]:
        dims = [d for d in c.get("dimensions", []) if d.get("id") and d.get("label")]
        if not c.get("name") or not c.get("scenario", "").strip() or not dims:
            raise HTTPException(422, "Each scenario needs a competency, scenario text and evidence dimensions")
        cid = c.get("id") or gemini._slug(c["name"])
        while cid in seen:
            cid += "_2"
        seen.add(cid)
        competencies.append({**c, "id": cid, "scenario": c["scenario"].strip(), "dimensions": dims})
    if not competencies:
        raise HTTPException(422, "Add at least one scenario")
    job = {"id": uuid.uuid4().hex[:8], "title": req.title.strip(), "description": req.description.strip(),
           "competencies": competencies, "created": time.time()}
    jobs = _saved_jobs()
    jobs[job["id"]] = job
    JOBS_FILE.parent.mkdir(exist_ok=True)
    JOBS_FILE.write_text(json.dumps(jobs, indent=2))
    return job


# ---------- Interview (candidate side) ----------

# In-memory sessions; this is a demo, nothing is persisted.
SESSIONS: dict[str, dict] = {}


class StartRequest(BaseModel):
    job_id: str = DEFAULT_JOB["id"]


def _new_state(competency):
    ids = [d["id"] for d in competency["dimensions"]]
    return {"turns": [], "probes": dict.fromkeys(ids, 0), "evidence": dict.fromkeys(ids),
            "assessment": None, "scorer": None}


@app.post("/api/session")
def start(req: StartRequest):
    job = _get_job(req.job_id)
    sid = uuid.uuid4().hex
    SESSIONS[sid] = {
        "job": job,
        "index": 0,
        "states": [_new_state(c) for c in job["competencies"]],
        "question": job["competencies"][0]["scenario"],
        "target": None,
        "done": False,
    }
    return {"session_id": sid, "question": SESSIONS[sid]["question"], "current": _view(SESSIONS[sid], 0)}


def _pick_target(competency, state) -> str | None:
    """The weakest dimension that is not yet strong and has not been probed too often."""
    candidates = [d["id"] for d in competency["dimensions"]
                  if state["assessment"][d["id"]]["status"] != "strong"
                  and state["probes"][d["id"]] < MAX_PROBES_PER_DIM]
    if not candidates:
        return None
    return min(candidates, key=lambda i: state["assessment"][i]["level"])


def _view(session, index):
    competency = session["job"]["competencies"][index]
    state = session["states"][index]
    assessment = state["assessment"]
    return {
        "index": index,
        "total": len(session["job"]["competencies"]),
        "name": competency["name"],
        "scenario_type": competency.get("scenario_type"),
        "dimensions": [
            {**d, **(assessment[d["id"]] if assessment else {"status": "missing"}),
             "rating": jev.rating(assessment[d["id"]]) if assessment else None,
             "evidence": state["evidence"][d["id"]]}
            for d in competency["dimensions"]
        ],
        "summary": jev.summarise(assessment) if assessment else None,
        "scorer": state["scorer"],
        "turns": state["turns"],
    }


def _result(session):
    views = [_view(session, i) for i in range(len(session["job"]["competencies"]))]
    # Competencies without enough evidence are reported as such and left out of the overall score.
    scores = [v["summary"]["score"] for v in views
              if v["summary"] and not v["summary"]["band"].startswith("INSUFFICIENT")]
    overall = round(sum(scores) / len(scores), 1) if scores else None
    if overall is None:
        band = "INSUFFICIENT EVIDENCE"
    elif overall >= 4:
        band = "STRONG EVIDENCE"
    elif overall >= 3:
        band = "MODERATE EVIDENCE"
    else:
        band = "LIMITED EVIDENCE"
    return {"title": session["job"]["title"],
            "overall": {"score": overall, "band": band, "assessed": len(scores), "total": len(views)},
            "competencies": views}


@app.post("/api/answer")
def answer(session_id: str = Form(...), text: str | None = Form(None), audio: UploadFile | None = File(None)):
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(404, "Unknown session")
    if session["done"]:
        raise HTTPException(400, "Interview already finished")

    if audio is not None:
        transcript = gemini.transcribe(audio.file.read(), audio.content_type or "audio/wav")
    else:
        transcript = (text or "").strip()
    if not transcript:
        raise HTTPException(422, "No speech detected. Please try recording again.")

    job, index = session["job"], session["index"]
    competency, state = job["competencies"][index], session["states"][index]
    state["turns"].append({"question": session["question"], "target": session["target"], "transcript": transcript})

    # Scoring sees text only: the transcript of this scenario so far.
    state["assessment"], state["scorer"] = jev.score(
        gemini.format_conversation(state["turns"]), job["title"], competency)

    n = len(job["competencies"])
    target = _pick_target(competency, state) if len(state["turns"]) < max_answers(n) else None
    analysis = gemini.analyse(state["turns"], job["title"], competency, target)
    for dim_id in state["evidence"]:
        # Only show a summary where Jev agrees evidence exists, so the panel never contradicts itself.
        evidenced = state["assessment"][dim_id]["status"] != "missing"
        state["evidence"][dim_id] = analysis["evidence"].get(dim_id) if evidenced else None

    advanced = False
    if target and analysis.get("follow_up"):
        state["probes"][target] += 1
        session["target"], session["question"] = target, analysis["follow_up"]
    elif index + 1 < n:
        advanced = True
        session["index"] += 1
        session["target"], session["question"] = None, job["competencies"][index + 1]["scenario"]
    else:
        session["done"] = True
        session["target"], session["question"] = None, None

    response = {"transcript": transcript, "answered": _view(session, index), "advanced": advanced,
                "next_question": session["question"], "target": session["target"], "done": session["done"]}
    if session["done"]:
        response["result"] = _result(session)
    else:
        response["current"] = _view(session, session["index"])
    return response


@app.post("/api/finish")
def finish(session_id: str = Form(...)):
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(404, "Unknown session")
    session["done"] = True
    return _result(session)


@app.get("/api/fairness")
def fairness():
    """Score two wordings of the same story. Presentation should not move the assessment."""
    competency = DEFAULT_JOB["competencies"][0]
    with ThreadPoolExecutor() as pool:
        results = dict(zip(FAIRNESS_PAIR, pool.map(
            lambda t: jev.score(t, DEFAULT_JOB["title"], competency), FAIRNESS_PAIR.values())))
    return {
        name: {"text": FAIRNESS_PAIR[name], "summary": jev.summarise(a), "scorer": scorer,
               "dimensions": [{"label": d["label"], **a[d["id"]], "rating": jev.rating(a[d["id"]])}
                              for d in competency["dimensions"]]}
        for name, (a, scorer) in results.items()
    }


# Mounted last so /api routes take precedence; serves the pages, style.css and the scripts from the root.
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
