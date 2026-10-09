# zeil-hackathon-2026

Evidence-Based AI Interviewer MVP: one competency (Problem Solving), five evidence dimensions,
adaptive follow-ups that target missing evidence, and an evidence-backed score.

## Run

```bash
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

- Candidate interview: http://localhost:8000 (pick a job, or use `?job=<id>`)
- Recruiter builder: http://localhost:8000/recruiter.html

`.env` needs `GEMINI_API_KEY` and `OPENROUTER_API_KEY`. Optional: `GEMINI_MODEL`, `GEMINI_GEN_MODEL`, `JEV_MODEL`.

## How it works

Recruiter side (`recruiter.html`, `gemini.generate_job`): job title + description + up to 3 competencies
-> one role-specific scenario per competency (mix of situational and behavioural) with a 4-5 point evidence
rubric -> recruiter edits -> publish (saved to `data/jobs.json`) -> candidate link.

Candidate side, for each scenario in turn:

```
record answer (browser, audio only; webcam is preview-only and never uploaded)
   -> Gemini: speech to text                      gemini.py  transcribe()
   -> Jev: classify transcript per dimension      jev.py     classify()   (text only, never audio)
        noul  = is evidence present?   score = how strong (0..3)
   -> pick weakest dimension not yet strong       main.py    _pick_target()
   -> Gemini: evidence summaries + one targeted follow-up   gemini.py analyse()
   -> repeat until all 5 dimensions are evidenced, or 5 answers
```

- Shared thresholds, the fairness rule, the default Senior AE job and the fairness pair live in `rubric.py`.
- Missing evidence is reported as "Insufficient evidence" and excluded from the score, not scored as poor.
- If Jev is unreachable, scoring falls back to Gemini on the same rubric and the UI says so.
- "Type instead" on the interview screen is the backup path if the mic or speech-to-text fails.

## Hands-free demo (voice)

Both pages have a voice bar at the bottom (Chrome only; uses Chrome's speech recognition for live captions).

- Recruiter: speak naturally, e.g. "I want to make a job for a machine learning engineer… the competencies are
  problem solving, technical communication and ownership… generate the scenarios… complete it… open the interview".
  Each phrase goes to Gemini (`/api/voice/recruiter`), which fills the form and/or triggers a command.
- Candidate: "start the interview"; recording starts automatically after each question is read out;
  say "that's my answer" to submit; "repeat the question"; "end the interview".

Before recording the demo, either run `./demo_chrome.sh` (a separate Chrome window that auto-accepts camera/mic
prompts and allows questions to be read aloud), or set Camera and Microphone to Allow for http://localhost:8000 in
Chrome's site settings. Voice mode is remembered, so after that nothing needs to be clicked.

## Evaluation and fairness

- After each scenario the candidate sees "Here's what we understood" (Gemini restates their answer claim by claim,
  adding nothing) and confirms or corrects it by voice. Jev scores both the raw transcript and the confirmed
  version; big differences are flagged for human review.
- The recruiter report shows Jev's numbers per dimension (probability evidence is present, strength on the
  4-level scale, confidence), the candidate's exact words (quotes are checked against the transcript), the
  evidence trail across follow-ups, and "needs human review" flags where Jev is borderline.
- `fairness_eval.py` scores the same stories in native and second-language phrasing, raw vs restated, and writes
  `results/fairness_eval.md`.
- Optional **Communication** competency for customer-facing roles: when generating scenarios, Gemini recommends
  whether the job needs it (with a reason); the recruiter switches it on or off. It's a role-play, scored by Jev
  on the candidate's own words against a fixed rubric (`COMMUNICATION_DIMENSIONS` in `rubric.py`), not restated,
  and never on accent, voice or grammar. Other competencies' rubrics are told not to include communication.
