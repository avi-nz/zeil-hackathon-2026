"""Shared rubric constants, plus the built-in default job (Senior AE / Problem Solving)."""

ROLE = "Senior Account Executive"
COMPETENCY = "Problem Solving"

DEFAULT_SCENARIO = (
    "Tell me about a time you faced a difficult problem with a client or a deal. "
    "What was going on, and how did you handle it?"
)

DIMENSIONS = [
    {
        "id": "problem_identification",
        "label": "Problem identified",
        "requirement": "Identify problem",
        "description": "The candidate states what the specific underlying problem was, "
                       "not just its symptoms, and why it mattered.",
    },
    {
        "id": "reasoning",
        "label": "Reasoning / diagnosis",
        "requirement": "Explain reasoning",
        "description": "The candidate explains how they worked out the cause: what information "
                       "they gathered, what they checked or ruled out, and why they concluded what they did.",
    },
    {
        "id": "alternatives",
        "label": "Alternatives considered",
        "requirement": "Consider alternatives",
        "description": "The candidate describes other options or approaches they considered "
                       "and why they chose one over the others.",
    },
    {
        "id": "action",
        "label": "Action taken",
        "requirement": "Take action",
        "description": "The candidate describes the concrete actions they personally took to solve the problem.",
    },
    {
        "id": "outcome",
        "label": "Outcome / verification",
        "requirement": "Evaluate outcome",
        "description": "The candidate describes the result and how they knew it worked "
                       "(a measurable outcome, feedback, or follow-up check).",
    },
]

DIM_BY_ID = {d["id"]: d for d in DIMENSIONS}

# Ordered scale Jev places each dimension on. Index 0 is "no evidence".
LEVELS = [
    "No evidence: the candidate did not state anything about this",
    "Vague: a generic claim with no specifics",
    "Specific: concrete details are given",
    "Detailed and convincing: specific, concrete and complete",
]

# Fairness constraint shared by every scoring instruction.
FAIRNESS_RULE = (
    "Judge only the content the candidate communicated. Do not reward or penalise accent, "
    "grammar, filler words (um, like, basically), vocabulary sophistication, confidence, "
    "answer length or polish. A casually worded answer with the same facts deserves the same judgement."
)

# A dimension counts as evidenced when Jev says so with p >= PRESENT_THRESHOLD,
# and as strong when its level is at least STRONG_LEVEL ("Specific").
PRESENT_THRESHOLD = 0.5
STRONG_LEVEL = 1.5

MAX_PROBES_PER_DIM = 2   # stop chasing a dimension after this many targeted follow-ups
MAX_COMPETENCIES = 3     # recruiter jobs are capped at this many scenarios for the MVP


def max_answers(n_competencies: int) -> int:
    """Answers allowed per competency: scenario + follow-ups. Shorter when a job has several scenarios."""
    return 5 if n_competencies == 1 else 3

# Two wordings of the same story, used for the presentation-sensitivity check.
FAIRNESS_PAIR = {
    "polished": (
        "Our largest enterprise client informed us they intended not to renew. I identified that the "
        "underlying issue was poor adoption: only a fraction of their licensed users were active. I analysed "
        "the usage data and interviewed three of their team leads, which ruled out pricing as the cause. "
        "I considered offering a discount, or escalating to our product team, but concluded that neither "
        "addressed adoption. Instead I set up a structured onboarding programme with weekly check-ins. "
        "Within two months active usage had doubled, and they renewed for a further two years."
    ),
    "casual": (
        "Yeah so, um, our biggest client basically said they weren't gonna renew. Turned out, like, hardly "
        "anyone over there was actually using it. I looked at the usage numbers and talked to three of their "
        "team leads and it wasn't the price thing. I thought about just giving them a discount or, you know, "
        "kicking it to product, but that wouldn't fix people not using it. So I did proper onboarding with them, "
        "weekly calls and stuff. Couple months later usage was like double and they signed on for two more years."
    ),
}

DEFAULT_JOB = {
    "id": "default",
    "title": ROLE,
    "description": "",
    "competencies": [{
        "id": "problem_solving",
        "name": COMPETENCY,
        "scenario": DEFAULT_SCENARIO,
        "scenario_type": "behavioural",
        "rationale": "",
        "dimensions": DIMENSIONS,
    }],
}
