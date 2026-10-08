// Recruiter interview builder. Shared helpers ($, api, postJson, escapeHtml, MARK) come from common.js.
const MAX_COMPETENCIES = 3;
const SUGGESTIONS = ["Problem Solving", "Technical Communication", "Ownership", "Collaboration",
  "Stakeholder Management", "Adaptability", "Attention to Detail", "Customer Focus"];
const EXAMPLE = {
  title: "Machine Learning Engineer",
  description: "Join our fintech lending team in Auckland. You'll build, deploy and monitor credit-risk and fraud " +
    "models used in real-time loan decisions. Stack: Python, PyTorch, XGBoost, Airflow, AWS SageMaker, Snowflake. " +
    "You'll work closely with risk analysts and product managers, own models in production (drift monitoring, " +
    "retraining), and explain model behaviour to compliance and non-technical stakeholders. Experience with " +
    "imbalanced data and model fairness in regulated environments is a plus.",
  competencies: ["Problem Solving", "Technical Communication", "Ownership in Production"],
};

let competencies = [];
let draft = null;

function show(screen) {
  for (const s of ["form", "review", "done"]) $(`screen-${s}`).classList.toggle("hidden", s !== screen);
  window.scrollTo(0, 0);
}

/* ---------- Competency chips ---------- */

function renderChips() {
  $("chips").innerHTML = competencies.map((c, i) =>
    `<span class="tag-chip">${escapeHtml(c)}<button type="button" data-i="${i}" aria-label="Remove">×</button></span>`).join("");
  $("comp-input").disabled = competencies.length >= MAX_COMPETENCIES;
  $("comp-input").placeholder = competencies.length >= MAX_COMPETENCIES
    ? "Maximum of 3 for this MVP" : "Type a competency and press Enter";
  $("suggestions").innerHTML = SUGGESTIONS
    .filter((s) => !competencies.some((c) => c.toLowerCase() === s.toLowerCase()))
    .map((s) => `<button type="button" class="suggest" ${competencies.length >= MAX_COMPETENCIES ? "disabled" : ""}>+ ${escapeHtml(s)}</button>`)
    .join("");
}

function addCompetency(name) {
  name = name.trim();
  if (!name || competencies.length >= MAX_COMPETENCIES) return;
  if (competencies.some((c) => c.toLowerCase() === name.toLowerCase())) return;
  competencies.push(name);
  renderChips();
}

$("comp-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addCompetency($("comp-input").value);
    $("comp-input").value = "";
  } else if (e.key === "Backspace" && !$("comp-input").value && competencies.length) {
    competencies.pop();
    renderChips();
  }
});
$("chips").onclick = (e) => {
  if (e.target.dataset.i === undefined) return;
  competencies.splice(Number(e.target.dataset.i), 1);
  renderChips();
};
$("suggestions").onclick = (e) => {
  if (e.target.classList.contains("suggest")) addCompetency(e.target.textContent.replace(/^\+ /, ""));
};
$("chip-input").onclick = () => $("comp-input").focus();

$("btn-example").onclick = () => {
  $("job-title").value = EXAMPLE.title;
  $("job-desc").value = EXAMPLE.description;
  competencies = [...EXAMPLE.competencies];
  renderChips();
};

/* ---------- Generate ---------- */

async function generate() {
  // Include anything typed but not yet turned into a chip.
  if ($("comp-input").value.trim()) {
    addCompetency($("comp-input").value);
    $("comp-input").value = "";
  }
  const button = $("btn-generate");
  button.disabled = $("btn-regen").disabled = true;
  button.textContent = "Designing scenarios from your job description…";
  $("btn-regen").textContent = "Regenerating…";
  $("form-error").classList.add("hidden");
  try {
    draft = await postJson("/api/jobs/generate", {
      title: $("job-title").value, description: $("job-desc").value, competencies,
    });
    renderReview();
    show("review");
  } catch (e) {
    $("form-error").textContent = e.message;
    $("form-error").classList.remove("hidden");
    show("form");
  } finally {
    button.disabled = $("btn-regen").disabled = false;
    button.textContent = "Generate screening scenarios";
    $("btn-regen").textContent = "Regenerate";
  }
}

$("job-form").onsubmit = (e) => {
  e.preventDefault();
  generate();
};
$("btn-regen").onclick = generate;
$("btn-back").onclick = () => show("form");

/* ---------- Review ---------- */

function renderReview() {
  $("review-title").textContent = draft.title;
  $("scenarios").innerHTML = draft.competencies.map((c, i) => `
    <article class="card scenario-card">
      <div class="scenario-top">
        <span class="num">${i + 1}</span>
        <div class="scenario-meta">
          <div class="label">Competency</div>
          <h3>${escapeHtml(c.name)}</h3>
        </div>
        <span class="chip">${scenarioTypeLabel(c.scenario_type)}</span>
        ${draft.competencies.length > 1 ? `<button class="link remove" data-i="${i}">Remove</button>` : ""}
      </div>
      <label class="label" for="scenario-${i}">Scenario the candidate will hear</label>
      <textarea class="scenario-text" id="scenario-${i}" data-i="${i}" rows="3">${escapeHtml(c.scenario)}</textarea>
      ${c.rationale ? `<p class="rationale"><strong>Why this scenario:</strong> ${escapeHtml(c.rationale)}</p>` : ""}
      <div class="label">Evidence the AI will look for</div>
      <ul class="evidence-list">${c.dimensions.map((d) => `<li>
        <span class="mark strong">✓</span>
        <div><div class="name">${escapeHtml(d.label)}</div><div class="desc">${escapeHtml(d.description)}</div></div>
      </li>`).join("")}</ul>
    </article>`).join("");
  $("btn-publish").disabled = false;
}

$("scenarios").addEventListener("input", (e) => {
  if (e.target.classList.contains("scenario-text")) draft.competencies[Number(e.target.dataset.i)].scenario = e.target.value;
});
$("scenarios").addEventListener("click", (e) => {
  if (!e.target.classList.contains("remove")) return;
  draft.competencies.splice(Number(e.target.dataset.i), 1);
  renderReview();
});

$("btn-publish").onclick = async () => {
  $("btn-publish").disabled = true;
  try {
    const job = await postJson("/api/jobs", draft);
    const link = new URL(`index.html?job=${job.id}`, location.href).href;
    $("candidate-link").value = link;
    $("btn-open").href = link;
    const n = job.competencies.length;
    $("done-summary").textContent = `${job.title} · ${n} scenario${n > 1 ? "s" : ""}: ${job.competencies.map((c) => c.name).join(", ")}`;
    show("done");
    loadJobs();
  } catch (e) {
    alert(e.message);
    $("btn-publish").disabled = false;
  }
};

/* ---------- Published ---------- */

$("btn-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("candidate-link").value);
  } catch {
    $("candidate-link").select();
    document.execCommand("copy");
  }
  $("btn-copy").textContent = "Copied";
  setTimeout(() => ($("btn-copy").textContent = "Copy"), 1500);
};

$("btn-new").onclick = () => {
  $("job-form").reset();
  competencies = [];
  renderChips();
  show("form");
};

async function loadJobs() {
  try {
    const jobs = (await api("/api/jobs")).filter((j) => j.id !== "default");
    $("jobs-list").classList.toggle("hidden", !jobs.length);
    $("jobs-list").innerHTML = `<div class="label">Your interviews</div>` + jobs.map((j) => `
      <div class="job-row">
        <div><div class="name">${escapeHtml(j.title)}</div><div class="muted">${j.competencies.map(escapeHtml).join(" · ")}</div></div>
        <a class="btn outline small" href="index.html?job=${j.id}">Open interview</a>
      </div>`).join("");
  } catch (e) {
    $("form-error").textContent = e.message;
    $("form-error").classList.remove("hidden");
  }
}

/* ---------- Presentation-sensitivity check ---------- */

$("btn-fairness").onclick = async () => {
  const box = $("fairness");
  box.innerHTML = `<p class="muted">Scoring two wordings of the same story with Jev…</p>`;
  try {
    const r = await api("/api/fairness");
    const col = (title, x) => `<div><div class="label">${title}</div>
      <blockquote>“${escapeHtml(x.text)}”</blockquote>
      <table>${x.dimensions.map((d) => `<tr><td>${escapeHtml(d.label)}</td><td><span class="mark ${d.status}">${MARK[d.status]}</span> ${d.rating.toFixed(1)}</td></tr>`).join("")}</table>
      <div class="fair-total">${x.summary.score?.toFixed(1) ?? "–"} / 5 <small class="label">${x.summary.band}</small></div></div>`;
    box.innerHTML = `
      <p>Same facts, different presentation. By design, changing style should not change the competency assessment.</p>
      ${r.polished.scorer === "jev" ? "" : `<p class="label">Jev unavailable, fallback scorer (Gemini)</p>`}
      <div class="fair-grid">${col("Candidate A: polished", r.polished)}${col("Candidate B: casual", r.casual)}</div>`;
  } catch (e) {
    box.innerHTML = `<p>${escapeHtml(e.message)}</p>`;
  }
};

renderChips();
loadJobs();
