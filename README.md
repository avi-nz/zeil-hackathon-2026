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

Before recording the demo: open both pages once, click the mic, and allow microphone and camera access
("allow on every visit"). Voice mode is remembered, so after that nothing needs to be clicked.
