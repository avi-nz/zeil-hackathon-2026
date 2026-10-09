"""ZEIL Evidence Interview MVP server.

Recruiter:  job title + description + competencies --Gemini--> role-specific scenarios + evidence rubrics
Candidate:  per scenario, audio --Gemini--> transcript --Jev--> evidence status --Gemini--> targeted follow-up
Run:  .venv/bin/python main.py   then open http://localhost:8000 (candidate) or /recruiter.html
"""
import json
import re
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
from rubric import (COMMUNICATION_DIMENSIONS, DEFAULT_JOB, FAIRNESS_PAIR, MAX_COMPETENCIES, MAX_PROBES_PER_DIM,
                    max_answers)

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
    communication: dict | None = None


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
    generated = gemini.generate_job(title, req.description.strip(), competencies)
    return {"title": title, "description": req.description.strip(), **generated}


@app.post("/api/jobs")
def save(req: SaveRequest):
    competencies, seen = [], set()
    for c in [c for c in req.competencies if c.get("kind") != "communication"][:MAX_COMPETENCIES]:
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

    # Spoken communication is only assessed if the recruiter opted in, and always with the fixed rubric.
    comm = req.communication or {}
    included = bool(comm.get("included")) and bool((comm.get("competency") or {}).get("scenario", "").strip())
    if included:
        c = comm["competency"]
        competencies.append({"id": "communication", "kind": "communication", "name": "Communication",
                             "scenario_type": "roleplay", "scenario": c["scenario"].strip(),
                             "rationale": c.get("rationale", ""), "dimensions": COMMUNICATION_DIMENSIONS})
    job = {"id": uuid.uuid4().hex[:8], "title": req.title.strip(), "description": req.description.strip(),
           "competencies": competencies, "created": time.time(),
           "communication": {"recommended": bool(comm.get("recommended")), "rationale": comm.get("rationale", ""),
                             "included": included}}
    jobs = _saved_jobs()
    jobs[job["id"]] = job
    JOBS_FILE.parent.mkdir(exist_ok=True)
    JOBS_FILE.write_text(json.dumps(jobs, indent=2))
    return job


class VoiceRequest(BaseModel):
    utterance: str
    screen: str = "form"
    form: dict = {}
    previous: str = ""
    scenarios: list[str] = []


@app.post("/api/voice/recruiter")
def recruiter_voice(req: VoiceRequest):
    """Hands-free recruiter: natural-language speech -> form updates and builder commands."""
    if not req.utterance.strip():
        raise HTTPException(422, "Empty utterance")
    return gemini.interpret_recruiter(req.utterance.strip(), req.screen, req.form, req.previous, req.scenarios)


# ---------- Interview (candidate side) ----------

# In-memory sessions; this is a demo, nothing is persisted.
SESSIONS: dict[str, dict] = {}


class StartRequest(BaseModel):
    job_id: str = DEFAULT_JOB["id"]


def _new_state(competency):
    ids = [d["id"] for d in competency["dimensions"]]
    return {"turns": [], "probes": dict.fromkeys(ids, 0), "evidence": dict.fromkeys(ids),
            "assessment": None, "raw": None, "scorer": None,
            # questioning -> confirming (candidate checks our restatement) -> complete
            "phase": "questioning", "claims": None, "corrections": 0, "confirmed": False}


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


def _verified_quote(quote: str | None, turns) -> str | None:
    """Only show a quote if it really appears in what the candidate said, so the report can't put words in their mouth."""
    if not quote:
        return None
    words = re.findall(r"[a-z0-9']+", quote.lower())
    spoken = " ".join(re.findall(r"[a-z0-9']+", " ".join(t["transcript"] for t in turns).lower()))
    return quote.strip().strip('"\u201c\u201d') if words and " ".join(words) in spoken else None


def _turn_label(turn, index):
    return "Scenario" if index == 0 else f"Follow-up {index}"


def _dimension_view(d, state):
    assessment, raw = state["assessment"], state["raw"]
    if not assessment:
        return {**d, "status": "missing", "trail": [], "review": []}
    a = assessment[d["id"]]
    evidence = state["evidence"][d["id"]] or {}
    review = jev.review_reasons(a)
    answers = [t for t in state["turns"] if t.get("kind") != "correction"]
    trail = [{"label": _turn_label(t, i), "status": t["statuses"][d["id"]], "targeted": t.get("target") == d["id"]}
             for i, t in enumerate(answers) if "statuses" in t]
    view = {**d, **a, "rating": jev.rating(a), "summary": evidence.get("summary"),
            "quote": _verified_quote(evidence.get("quote"), state["turns"]), "trail": trail, "review": review,
            "found_in": next((step["label"] for step in trail if step["status"] != "missing"), None)}
    if state["confirmed"] and raw:
        r = raw[d["id"]]
        view["raw_status"], view["raw_level"] = r["status"], r["level"]
        if r["status"] == "missing" and a["status"] != "missing":
            review.append("Evidenced only after restating: check it against the transcript")
        elif r["status"] != "missing" and a["status"] == "missing":
            review.append("Evidence in the transcript was lost in the restatement")
        elif abs(r["level"] - a["level"]) >= 0.75:
            review.append(f"Restating changed the strength ({r['level']:.1f} raw vs {a['level']:.1f} confirmed)")
    return view


def _view(session, index):
    competency = session["job"]["competencies"][index]
    state = session["states"][index]
    dims = [_dimension_view(d, state) for d in competency["dimensions"]]
    return {
        "index": index,
        "total": len(session["job"]["competencies"]),
        "name": competency["name"],
        "kind": competency.get("kind", "content"),
        "scenario_type": competency.get("scenario_type"),
        "dimensions": dims,
        "summary": jev.summarise(state["assessment"]) if state["assessment"] else None,
        "raw_summary": jev.summarise(state["raw"]) if state["confirmed"] and state["raw"] else None,
        # An unconfirmed summary is one flag for the whole scenario (shown as a chip), not one per dimension.
        "flagged": sum(1 for d in dims if d.get("review")) + (state["phase"] == "unconfirmed"),
        "scorer": state["scorer"],
        "phase": state["phase"],
        "claims": state["claims"],
        "confirmed": state["confirmed"],
        "corrections": state["corrections"],
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
    return {"title": session["job"]["title"], "communication": session["job"].get("communication"),
            "overall": {"score": overall, "band": band, "assessed": len(scores), "total": len(views),
                        "flagged": sum(v["flagged"] for v in views)},
            "competencies": views}


def _session_or_404(session_id):
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(404, "Unknown session")
    if session["done"]:
        raise HTTPException(400, "Interview already finished")
    return session


def _speech(text, audio) -> str:
    transcript = gemini.transcribe(audio.file.read(), audio.content_type or "audio/wav") if audio is not None \
        else (text or "").strip()
    if not transcript:
        raise HTTPException(422, "No speech detected. Please try recording again.")
    return transcript


def _advance(session, index):
    """Move on to the next scenario, or finish, and build the response."""
    job = session["job"]
    advanced = index + 1 < len(job["competencies"])
    if advanced:
        session["index"] += 1
        session["question"] = job["competencies"][index + 1]["scenario"]
    else:
        session["done"] = True
        session["question"] = None
    session["target"] = None
    response = {"phase": "questioning", "answered": _view(session, index), "advanced": advanced,
                "next_question": session["question"], "target": None, "done": session["done"]}
    if session["done"]:
        response["result"] = _result(session)
    else:
        response["current"] = _view(session, session["index"])
    return response


@app.post("/api/answer")
def answer(session_id: str = Form(...), text: str | None = Form(None), audio: UploadFile | None = File(None)):
    session = _session_or_404(session_id)
    job, index = session["job"], session["index"]
    competency, state = job["competencies"][index], session["states"][index]
    if state["phase"] != "questioning":
        raise HTTPException(400, "Please confirm the summary first")
    transcript = _speech(text, audio)
    turn = {"question": session["question"], "target": session["target"], "transcript": transcript}
    state["turns"].append(turn)

    # Scoring sees text only: the transcript of this scenario so far.
    state["assessment"], state["scorer"] = jev.score(
        gemini.format_conversation(state["turns"]), job["title"], competency)
    turn["statuses"] = {k: v["status"] for k, v in state["assessment"].items()}

    target = _pick_target(competency, state) if len(state["turns"]) < max_answers(len(job["competencies"])) else None
    analysis = gemini.analyse(state["turns"], job["title"], competency, target)
    for dim_id in state["evidence"]:
        # Only show evidence where Jev agrees it exists, so the panel never contradicts itself.
        evidenced = state["assessment"][dim_id]["status"] != "missing"
        state["evidence"][dim_id] = analysis["evidence"].get(dim_id) if evidenced else None

    if target and analysis.get("follow_up"):
        state["probes"][target] += 1
        session["target"], session["question"] = target, analysis["follow_up"]
        return {"phase": "questioning", "transcript": transcript, "answered": _view(session, index),
                "advanced": False, "next_question": session["question"], "target": target, "done": False}

    session["target"] = None
    if competency.get("kind") == "communication":
        # Communication is judged on the candidate's own words: restating would tidy up exactly what we measure.
        state["phase"], state["raw"] = "complete", None
        return {"transcript": transcript, **_advance(session, index)}

    # Questioning is over for this scenario: restate what we understood and ask the candidate to confirm it.
    state["phase"] = "confirming"
    state["claims"] = gemini.restate(state["turns"], job["title"], competency)
    session["target"] = None
    return {"phase": "confirm", "transcript": transcript, "claims": state["claims"], "answered": _view(session, index),
            "advanced": False, "done": False}


@app.post("/api/confirm")
def confirm(session_id: str = Form(...), decision: str = Form(...), text: str | None = Form(None),
            audio: UploadFile | None = File(None)):
    """The candidate confirms our restatement ("yes") or corrects it. Jev then scores both versions."""
    session = _session_or_404(session_id)
    job, index = session["job"], session["index"]
    competency, state = job["competencies"][index], session["states"][index]
    if state["phase"] != "confirming":
        raise HTTPException(400, "Nothing to confirm")

    if decision == "correct":
        correction = _speech(text, audio)
        state["turns"].append({"question": "Correction to our summary", "kind": "correction",
                               "transcript": correction, "target": None})
        state["claims"] = gemini.revise_restatement(state["claims"], correction)
        state["corrections"] += 1
        return {"phase": "confirm", "transcript": correction, "claims": state["claims"],
                "answered": _view(session, index), "advanced": False, "done": False}

    # Score what they said (raw transcript) and what they confirmed they meant, side by side.
    with ThreadPoolExecutor() as pool:
        raw_job = pool.submit(jev.score, gemini.format_conversation(state["turns"]), job["title"], competency)
        confirmed_job = pool.submit(jev.score, gemini.format_claims(state["claims"]), job["title"], competency)
        (state["raw"], _), (state["assessment"], state["scorer"]) = raw_job.result(), confirmed_job.result()
    state["confirmed"], state["phase"] = True, "complete"
    return _advance(session, index)


@app.post("/api/finish")
def finish(session_id: str = Form(...)):
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(404, "Unknown session")
    for state in session["states"]:
        if state["turns"] and not state["confirmed"] and state["phase"] != "complete":
            state["phase"] = "unconfirmed"
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
