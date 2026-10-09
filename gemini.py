"""Gemini: speech-to-text, evidence summaries, targeted follow-ups, and recruiter scenario generation."""
import base64
import json
import os
import re

import requests
from dotenv import load_dotenv

from rubric import COMMUNICATION_DIMENSIONS, LEVELS, MAX_COMPETENCIES, rule_for

load_dotenv()

MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")
# Scenario generation: tested ~4s with specific, role-grounded output (gemini-flash-latest took ~100s).
GEN_MODEL = os.getenv("GEMINI_GEN_MODEL", "gemini-3.5-flash-lite")


def _generate(parts, schema=None, temperature=0.2, model=MODEL) -> str:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    config = {"temperature": temperature}
    if schema:
        config["responseMimeType"] = "application/json"
        config["responseSchema"] = schema
    response = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        json={"contents": [{"role": "user", "parts": parts}], "generationConfig": config},
        timeout=120,
    )
    response.raise_for_status()
    candidate = response.json()["candidates"][0]
    return "".join(p.get("text", "") for p in candidate["content"]["parts"]).strip()


def transcribe(audio: bytes, mime_type: str = "audio/wav") -> str:
    return _generate([
        {"inline_data": {"mime_type": mime_type, "data": base64.b64encode(audio).decode()}},
        {"text": "Transcribe this interview answer verbatim, including filler words. The speaker may not be a "
                 "native English speaker: write exactly what they said, do not correct their grammar or wording, and "
                 "write [inaudible] for any word you cannot make out rather than guessing. If it ends with a spoken "
                 "command such as \"that's my answer\", \"I'm done\" or \"next question\", leave that command out. "
                 "Return only the transcript text. If there is no speech, return an empty string."},
    ], temperature=0)


def format_conversation(turns) -> str:
    return "\n\n".join(f"INTERVIEWER: {t['question']}\nCANDIDATE: {t['transcript']}" for t in turns)


def _rubric(competency) -> str:
    return "\n".join(f"- {d['id']}: {d['label']}. {d['description']}" for d in competency["dimensions"])


def analyse(turns, role: str, competency: dict, target_id: str | None) -> dict:
    """Extract evidence summaries per dimension and, if target_id is set, write a follow-up for it."""
    dims = competency["dimensions"]
    if target_id and competency.get("kind") == "communication":
        target = next(d for d in dims if d["id"] == target_id)
        follow_up_task = (
            f"This is a role-play. Continue it: write the LISTENER's next line (one or two sentences, in character, "
            f"in quotes) that naturally gives the candidate another chance to show '{target['label']}' "
            f"({target['description']}). For example the listener might push back, ask what happens now, or say "
            f"they don't understand. Never coach the candidate or hint at what a good reply contains."
        )
    elif target_id:
        target = next(d for d in dims if d["id"] == target_id)
        follow_up_task = (
            f"The evidence for '{target['label']}' is still missing or vague. Write ONE short, natural, "
            f"conversational follow-up question that refers to the specifics of what the candidate said and "
            f"is designed to draw out exactly this evidence: {target['description']} "
            f"Ask an open question: never name a technique, tool, metric or approach the candidate has not "
            f"already mentioned, and do not hint at what a good answer contains. Do not repeat an earlier question."
        )
    else:
        follow_up_task = "No follow-up is needed; set follow_up to null."

    schema = {
        "type": "object",
        "properties": {
            "evidence": {
                "type": "object",
                "properties": {d["id"]: {
                    "type": "object",
                    "properties": {"summary": {"type": "string", "nullable": True},
                                   "quote": {"type": "string", "nullable": True}},
                    "required": ["summary", "quote"],
                } for d in dims},
                "required": [d["id"] for d in dims],
            },
            "follow_up": {"type": "string", "nullable": True},
        },
        "required": ["evidence", "follow_up"],
    }
    prompt = f"""You are an evidence collector in a structured interview for the role {role}.
Competency: {competency['name']}. Evidence dimensions:
{_rubric(competency)}

Conversation so far:
{format_conversation(turns)}

Task 1: For each dimension give:
- summary: one sentence on the evidence the CANDIDATE explicitly stated, in third person ("Candidate ..."),
  staying close to their own words. Never invent or infer evidence that was not stated.
- quote: the single most relevant span of the CANDIDATE's words, copied EXACTLY character for character
  (including filler words and any grammar mistakes), at most 30 words. It must appear verbatim in a CANDIDATE line.
Use null for both if there is no evidence. {rule_for(competency)}

Task 2: {follow_up_task}"""

    return json.loads(_generate([{"text": prompt}], schema=schema))


def classify(transcript: str, competency: dict) -> dict:
    """Fallback scorer with the same rubric and output shape as Jev, used only if Jev is unreachable."""
    dims = competency["dimensions"]
    levels = "\n".join(f"{i}: {level}" for i, level in enumerate(LEVELS))
    schema = {
        "type": "object",
        "properties": {d["id"]: {
            "type": "object",
            "properties": {"present": {"type": "number"}, "level": {"type": "number"}},
            "required": ["present", "level"],
        } for d in dims},
        "required": [d["id"] for d in dims],
    }
    prompt = f"""Classify the evidence in this interview transcript for the competency {competency['name']}.
Dimensions:
{_rubric(competency)}

For each dimension give "present": the probability (0 to 1) that the candidate explicitly stated evidence for it,
and "level": a number from 0 to {len(LEVELS) - 1} on this scale:
{levels}
Only count what was actually stated. {rule_for(competency)}

Transcript:
{transcript}"""
    raw = json.loads(_generate([{"text": prompt}], schema=schema, temperature=0))
    top = len(LEVELS) - 1
    return {k: {"present": min(max(float(v["present"]), 0), 1), "level": min(max(float(v["level"]), 0), top),
                "confidence": 0} for k, v in raw.items()}


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:40] or "item"


_JOB_SCHEMA = {
    "type": "object",
    "properties": {
        "competencies": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "scenario_type": {"type": "string", "enum": ["behavioural", "situational"]},
                    "scenario": {"type": "string"},
                    "rationale": {"type": "string"},
                    "dimensions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "requirement": {"type": "string"},
                                "description": {"type": "string"},
                            },
                            "required": ["label", "requirement", "description"],
                        },
                    },
                },
                "required": ["name", "scenario_type", "scenario", "rationale", "dimensions"],
            },
        },
        "communication": {
            "type": "object",
            "properties": {
                "recommended": {"type": "boolean"},
                "rationale": {"type": "string"},
                "listener": {"type": "string"},
                "scenario": {"type": "string"},
            },
            "required": ["recommended", "rationale", "listener", "scenario"],
        },
    },
    "required": ["competencies", "communication"],
}


def generate_job(title: str, description: str, competencies: list[str]) -> list[dict]:
    """Turn a job description and competencies into role-specific screening scenarios with evidence rubrics."""
    if competencies:
        which = "Use exactly these competencies, in this order: " + "; ".join(competencies[:MAX_COMPETENCIES])
    else:
        which = f"Choose the {MAX_COMPETENCIES} competencies that matter most for this job description."

    prompt = f"""You design structured, evidence-based screening interviews.

JOB TITLE: {title}
JOB DESCRIPTION:
{description or "(none provided)"}

{which}

For each competency write ONE interview scenario and an evidence rubric.

Scenario rules:
- Ground every scenario in the specifics of THIS job: its domain, tools, data, stakeholders, constraints and
  typical failure modes named or clearly implied by the description. A scenario that would fit any job is a failure.
  Bad: "Tell me about a time you solved a difficult problem."
  Good (ML engineer): "Your churn model scored 0.91 AUC offline, but two weeks after launch the retention team
  says its predictions are no better than random. Walk me through how you'd work out what went wrong."
- Mix formats: at least one "situational" scenario (a realistic hypothetical work situation, "you're facing X,
  what do you do?") and at least one "behavioural" scenario (a real past experience, anchored in a concrete
  situation relevant to the role, not a generic "tell me about a time").
- Each scenario must be answerable out loud in 2-3 minutes, without proprietary knowledge of the company.
- Keep it to 2-3 short sentences in plain, warm, spoken language. Set up ONE concrete situation; do not
  pack in lists of tools or tell the candidate which approaches to consider.
- Do not reward insider jargon, culture fit, or background unrelated to doing the job.

Rubric rules:
- 4 or 5 evidence dimensions per competency that together show the competency in action for this scenario.
- Each dimension must be observable in what a candidate SAYS (explicit content), never in how they sound.
- Measure the competency itself: what the candidate did or would do, and why. Unless the competency is itself
  about communication, do NOT include dimensions about how well they explain, phrase or communicate things
  ("plain language", "clear explanation", acknowledging feelings, empathy, de-escalation): spoken communication
  is assessed separately, only if the recruiter chooses to. Keep each competency's dimensions specific to it and do
  not repeat dimensions that belong to another listed competency.
- Describe the KIND of evidence, not a required answer. Never require specific tool names, techniques or
  terminology: any sound approach explained in plain words must count. (Bad: "uses PSI or KS-tests".
  Good: "explains how they would check whether the incoming data differs from the training data".)
- label: 2-4 words. requirement: a short imperative ("Diagnose root cause"). description: one sentence starting
  "The candidate ..." describing what explicit evidence looks like.

rationale: one sentence on why this scenario tests the competency for this specific role.

Separately, fill "communication": should this hiring process ALSO assess spoken communication as its own
competency? Recommend it only if explaining things to people (customers, patients, clients, non-technical
stakeholders) is a core, frequent part of THIS job as described; not merely because teamwork exists.
- recommended: true or false. rationale: one sentence citing what in the description supports the decision.
- listener: who the candidate would most often need to explain things to in this job (e.g. "an upset customer").
- scenario: a short ROLE-PLAY set in this job, spoken to the candidate: "I'll play [listener]. [Situation in
  1-2 sentences, including what the listener says.] Respond to me as you would in real life." It should need
  the candidate to explain something clearly to that listener. Write it even if not recommended."""

    raw = json.loads(_generate([{"text": prompt}], schema=_JOB_SCHEMA, temperature=0.7, model=GEN_MODEL))
    comm = raw["communication"]
    communication = {
        "recommended": bool(comm["recommended"]), "rationale": comm["rationale"],
        "competency": {"id": "communication", "kind": "communication", "name": "Communication",
                       "scenario_type": "roleplay", "scenario": comm["scenario"],
                       "rationale": f"Role-play with {comm['listener']}: tests whether the candidate can get a "
                                    f"message across clearly to the people this job involves.",
                       "dimensions": COMMUNICATION_DIMENSIONS},
    }
    result = []
    for c in raw["competencies"][:MAX_COMPETENCIES]:
        dims, seen = [], set()
        for d in c["dimensions"][:5]:
            dim_id = _slug(d["label"])
            while dim_id in seen:
                dim_id += "_2"
            seen.add(dim_id)
            dims.append({"id": dim_id, **d})
        result.append({"id": _slug(c["name"]), **c, "dimensions": dims})
    return {"competencies": result, "communication": communication}


RECRUITER_COMMANDS = ["none", "generate", "regenerate", "publish", "edit_job", "remove_scenario",
                      "open_interview", "new_job", "include_communication", "exclude_communication"]

_RECRUITER_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "nullable": True},
        "description": {"type": "string", "nullable": True},
        "competencies": {"type": "array", "items": {"type": "string"}, "nullable": True},
        "command": {"type": "string", "enum": RECRUITER_COMMANDS},
        "scenario_number": {"type": "integer", "nullable": True},
        "reply": {"type": "string"},
    },
    "required": ["title", "description", "competencies", "command", "scenario_number", "reply"],
}


def interpret_recruiter(utterance: str, screen: str, form: dict, previous: str, scenarios: list[str]) -> dict:
    """Turn one spoken recruiter utterance into form updates and/or a command for the interview builder."""
    prompt = f"""You are the voice assistant of a recruiter's interview builder. The recruiter is speaking hands-free;
speech recognition may contain small errors, so interpret intent sensibly.

Current screen: {screen}
  - "form": filling in the job (title, description, up to {MAX_COMPETENCIES} competencies)
  - "review": reviewing generated scenarios: {scenarios or "(none)"}
  - "done": the interview has been published
Current form:
  title: {form.get("title") or "(empty)"}
  description: {form.get("description") or "(empty)"}
  competencies: {form.get("competencies") or "(none)"}
Previous utterance: {previous or "(none)"}

New utterance: "{utterance}"

Return the NEW full value for any field the recruiter changed, and null for fields they did not mention.
- title: a clean job title, e.g. "Machine Learning Engineer" (fix casing; "ML engineer" -> "Machine Learning Engineer").
- description: a clear job description in full, punctuated sentences addressed to the candidate ("You'll ..."),
  with proper capitalisation of tools (Python, AWS). Remove filler words but do not invent responsibilities,
  tools or requirements they did not say. If they are adding to an existing description (or the previous
  utterance was dictating it and this one continues it), keep the existing sentences and add the new content
  as new sentences in the same style.
- competencies: the full list after the change, max {MAX_COMPETENCIES}, Title Case. "add X" keeps the existing ones;
  "remove X" drops it; a fresh list replaces them.
- command, only if they clearly ask for it:
  generate (create/generate the scenarios, on the form screen), regenerate (try again / new scenarios, on review),
  publish (publish / complete / finish / done / looks good / save, on review), edit_job (go back and edit the job),
  remove_scenario (with scenario_number, 1-based), open_interview (open / start / launch the candidate interview,
  on done), new_job (create another job). Otherwise "none". Fields and a command can come in the same utterance.
- If the utterance is not directed at the builder (small talk, noise), change nothing and use "none".
- include_communication / exclude_communication (on review): add or remove the communication assessment,
  e.g. "include communication", "we don't need to assess communication".
- reply: a very short confirmation of what you did, e.g. "Title set. Added 3 competencies." or "Generating scenarios."
  If nothing changed, a short hint of what they can say next."""
    result = json.loads(_generate([{"text": prompt}], schema=_RECRUITER_SCHEMA, temperature=0))
    if result.get("competencies") is not None:
        result["competencies"] = result["competencies"][:MAX_COMPETENCIES]
    return result


_CLAIMS_SCHEMA = {
    "type": "object",
    "properties": {"claims": {"type": "array", "items": {"type": "string"}}},
    "required": ["claims"],
}

_RESTATE_RULES = """Rules:
- One short, plain-English sentence per claim, addressed to the candidate as "You ..." (e.g. "You checked the logs.").
- Keep EVERY substantive thing they said: situation, reasoning, options, actions, results, numbers, names, tools.
- Keep their level of detail. Do not make a vague statement specific, and do not add reasons, steps, results or
  outcomes they did not say. If they did not say something, it must not appear.
- Only fix grammar, word choice and fluency, so the meaning is clear regardless of how fluently it was said.
- If a part is unclear or garbled, keep your best reading and mark it, e.g. "You [unclear: changed the retry
  settings]."
- Keep the order they said it in. At most 8 claims. Do not evaluate or praise."""


def restate(turns, role: str, competency: dict) -> list[str]:
    """Restate what the candidate said, claim by claim, in plain English, for the candidate to confirm."""
    prompt = f"""A candidate for the role {role} answered interview questions about {competency['name']}.
Restate what the CANDIDATE said so they can confirm we understood them correctly.

{_RESTATE_RULES}

Conversation:
{format_conversation(turns)}"""
    return json.loads(_generate([{"text": prompt}], schema=_CLAIMS_SCHEMA, temperature=0))["claims"]


def revise_restatement(claims: list[str], correction: str) -> list[str]:
    """Apply the candidate's spoken correction to the restated claims."""
    current = "\n".join(f"- {c}" for c in claims)
    prompt = f"""We restated a candidate's interview answer as these claims and asked if we understood correctly:
{current}

The candidate replied with this correction:
"{correction}"

Return the corrected list of claims: fix anything they say we got wrong, add anything they say we missed, and
remove anything they say they did not say. Leave everything else exactly as it is.

{_RESTATE_RULES}"""
    return json.loads(_generate([{"text": prompt}], schema=_CLAIMS_SCHEMA, temperature=0))["claims"]


def format_claims(claims: list[str]) -> str:
    return ("Confirmed summary of the candidate's answers. The candidate reviewed and approved these statements "
            "('you' = the candidate):\n" + "\n".join(f"- {c}" for c in claims))
