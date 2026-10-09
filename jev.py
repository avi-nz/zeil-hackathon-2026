"""Evidence classification with Jev (typesafe/jev-1.13) via the OpenRouter Decisions API.

Jev only ever sees the transcript text, never the audio, so voice characteristics
cannot reach the scorer.
"""
import os
import time

import requests
from dotenv import load_dotenv

import gemini

from rubric import LEVELS, PRESENT_THRESHOLD, STRONG_LEVEL, rule_for

load_dotenv()

URL = "https://openrouter.ai/api/alpha/decisions"
MODEL = os.getenv("JEV_MODEL", "typesafe/jev-1.13")


def _questions(competency):
    rule = rule_for(competency)
    questions = {}
    for d in competency["dimensions"]:
        questions[f"{d['id']}__present"] = {
            "type": "noul",
            "instructions": f"Does the candidate's answer contain explicit evidence for '{d['label']}'? "
                            f"{d['description']} Only count what was actually stated. {rule}",
            "criteria": {
                "true": "The candidate explicitly stated information that demonstrates this.",
                "false": "The candidate did not state this, or only implied it.",
            },
        }
        questions[f"{d['id']}__level"] = {
            "type": "score",
            "instructions": f"How strong is the stated evidence for '{d['label']}'? "
                            f"{d['description']} {rule}",
            "criteria": LEVELS,
        }
    return questions


def classify(transcript: str, role: str, competency: dict) -> dict:
    """Classify a candidate transcript against every rubric dimension of one competency.

    Returns {dim_id: {"present": p_yes, "level": 0..3, "confidence": c, "status": missing|partial|strong}}.
    """
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")

    payload = {
        "model": MODEL,
        "state": {"role": role, "competency": competency["name"], "interview_transcript": transcript},
        "questions": _questions(competency),
    }
    for attempt in range(3):  # the alpha endpoint occasionally returns 5xx
        response = requests.post(
            URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=60,
        )
        if response.status_code < 500:
            break
        time.sleep(0.5 * (attempt + 1))
    response.raise_for_status()
    answers = response.json()["answers"]
    return _with_status({
        d["id"]: {
            "present": answers[f"{d['id']}__present"]["noul"],
            "level": answers[f"{d['id']}__level"]["score"],
            "confidence": answers[f"{d['id']}__level"].get("confidence", 0),
        }
        for d in competency["dimensions"]
    })


def _with_status(raw: dict) -> dict:
    result = {}
    for dim_id, r in raw.items():
        if r["present"] < PRESENT_THRESHOLD:
            status = "missing"
        elif r["level"] < STRONG_LEVEL:
            status = "partial"
        else:
            status = "strong"
        result[dim_id] = {"present": round(r["present"], 3), "level": round(r["level"], 2),
                          "confidence": round(r["confidence"], 2), "status": status}
    return result


def score(transcript: str, role: str, competency: dict) -> tuple[dict, str]:
    """Score with Jev; if Jev is unreachable, fall back to Gemini on the same rubric so the demo keeps running."""
    try:
        return classify(transcript, role, competency), "jev"
    except requests.RequestException as exc:
        print(f"Jev unavailable, using Gemini fallback scorer: {exc}")
        return _with_status(gemini.classify(transcript, competency)), "gemini-fallback"


def review_reasons(dim: dict) -> list[str]:
    """Where Jev's own numbers say the verdict is uncertain, ask a human to look rather than pretending."""
    reasons = []
    if 0.35 <= dim["present"] <= 0.65:
        reasons.append(f"Borderline: Jev is {round(dim['present'] * 100)}% sure evidence is present")
    elif dim["status"] != "missing" and abs(dim["level"] - STRONG_LEVEL) < 0.3:
        reasons.append("Borderline between partial and strong evidence")
    if dim["status"] != "missing" and dim["confidence"] and dim["confidence"] < 0.5:
        reasons.append("Jev's strength rating is spread across levels (low confidence)")
    return reasons


def rating(dim: dict) -> float:
    """Map a Jev level (0..3) to a 1..5 rating."""
    return round(1 + dim["level"] * 4 / (len(LEVELS) - 1), 1)


def summarise(assessment: dict) -> dict:
    """Overall score from evidenced dimensions only. Missing evidence is reported, not penalised."""
    evidenced = [d for d in assessment.values() if d["status"] != "missing"]
    coverage = len(evidenced)
    score = round(sum(rating(d) for d in evidenced) / coverage, 1) if coverage else None
    if coverage < 3:
        band = "INSUFFICIENT EVIDENCE"
    elif score >= 4:
        band = "STRONG EVIDENCE"
    elif score >= 3:
        band = "MODERATE EVIDENCE"
    else:
        band = "LIMITED EVIDENCE"
    return {"score": score, "band": band, "coverage": coverage, "total": len(assessment)}
