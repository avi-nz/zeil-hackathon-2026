// Recruiter interview builder. Shared helpers ($, api, postJson, escapeHtml) come from common.js.
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
let screen = "form";

function show(name) {
  screen = name;
  for (const s of ["form", "review", "done"]) $(`screen-${s}`).classList.toggle("hidden", s !== name);
  window.scrollTo(0, 0);
  voice.render();
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
    // Gemini only recommends; the recruiter decides (the switch on the review screen).
    draft.communication.included = draft.communication.recommended;
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
  renderCommunication();
}

/* ---------- Optional communication assessment ---------- */

function renderCommunication() {
  const comm = draft.communication;
  const c = comm.competency;
  $("communication").innerHTML = `
    <article class="card scenario-card comm-card ${comm.included ? "" : "off"}">
      <div class="scenario-top">
        <span class="num comm-num">💬</span>
        <div class="scenario-meta">
          <div class="label">Optional competency</div>
          <h3>Communication</h3>
        </div>
        <span class="chip">Role-play</span>
        <div class="switch" role="group" aria-label="Include communication">
          <button type="button" data-include="1" class="${comm.included ? "on" : ""}">Include</button>
          <button type="button" data-include="0" class="${comm.included ? "" : "on"}">Don't include</button>
        </div>
      </div>
      <div class="recommendation ${comm.recommended ? "yes" : "no"}">
        <strong>${comm.recommended ? "Gemini recommends assessing communication for this role." : "Gemini doesn't recommend assessing communication for this role."}</strong>
        ${escapeHtml(comm.rationale)} <span class="muted">You decide.</span>
      </div>
      ${comm.included ? `
        <label class="label" for="comm-scenario">Role-play the candidate will hear</label>
        <textarea class="scenario-text" id="comm-scenario" rows="3">${escapeHtml(c.scenario)}</textarea>
        <p class="rationale"><strong>How it's scored:</strong> from the candidate's words only, never accent, voice,
          grammar slips or vocabulary. It isn't restated before scoring, because how they put things is what's measured.</p>
        <div class="label">Evidence the AI will look for (fixed rubric)</div>
        <ul class="evidence-list">${c.dimensions.map((d) => `<li>
          <span class="mark strong">✓</span>
          <div><div class="name">${escapeHtml(d.label)}</div><div class="desc">${escapeHtml(d.description)}</div></div>
        </li>`).join("")}</ul>` : ""}
    </article>`;
}

function setCommunication(included) {
  draft.communication.included = included;
  renderCommunication();
}

$("communication").addEventListener("click", (e) => {
  if (e.target.dataset.include !== undefined) setCommunication(e.target.dataset.include === "1");
});
$("communication").addEventListener("input", (e) => {
  if (e.target.id === "comm-scenario") draft.communication.competency.scenario = e.target.value;
});

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

/* ---------- Hands-free voice ---------- */

const HINTS = {
  form: "Try: “I want to create a job for a Machine Learning Engineer…” · “The competencies are…” · “Generate the scenarios”",
  review: "Say: “Complete” to publish · “Include communication” / “Don't assess communication” · “Regenerate” · “Remove scenario 2”",
  done: "Say: “Open the interview” · “Create another job”",
};

const voice = new VoiceControl({ onPhrase: queuePhrase, hint: () => HINTS[screen] });
let pending = "", pendingTimer = null, previousUtterance = "", voiceQueue = Promise.resolve();

// Speech recognition finalises after short pauses, so join phrases that arrive close together into one utterance.
function queuePhrase(text) {
  pending = `${pending} ${text}`.trim();
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    const utterance = pending;
    pending = "";
    voiceQueue = voiceQueue.then(() => handleUtterance(utterance));
  }, 900);
}

function flash(el) {
  el.classList.remove("voice-filled");
  void el.offsetWidth;
  el.classList.add("voice-filled");
}

async function handleUtterance(utterance) {
  voice.setStatus(`“${utterance}” · working…`);
  let r;
  try {
    r = await postJson("/api/voice/recruiter", {
      utterance, screen, previous: previousUtterance,
      form: { title: $("job-title").value, description: $("job-desc").value, competencies },
      scenarios: draft ? draft.competencies.map((c) => c.name) : [],
    });
  } catch (e) {
    voice.setStatus(e.message);
    return;
  }
  previousUtterance = utterance;
  voice.setStatus(`✓ ${r.reply}`);

  if (r.title != null) { $("job-title").value = r.title; flash($("job-title")); }
  if (r.description != null) { $("job-desc").value = r.description; flash($("job-desc")); }
  if (r.competencies != null) { competencies = r.competencies.slice(0, MAX_COMPETENCIES); renderChips(); flash($("chip-input")); }

  if (r.command === "generate" && screen === "form") await generate();
  else if (r.command === "regenerate" && screen === "review") await generate();
  else if (r.command === "publish" && screen === "review") $("btn-publish").click();
  else if (r.command === "edit_job") show("form");
  else if (r.command === "remove_scenario" && screen === "review" && draft.competencies.length > 1) {
    const i = (r.scenario_number || 0) - 1;
    if (i >= 0 && i < draft.competencies.length) { draft.competencies.splice(i, 1); renderReview(); }
  } else if (r.command === "open_interview" && screen === "done") location.href = `${$("btn-open").href}&voice=1`;
  else if (r.command === "new_job") $("btn-new").click();
  else if (r.command === "include_communication" && screen === "review") setCommunication(true);
  else if (r.command === "exclude_communication" && screen === "review") setCommunication(false);
}

renderChips();
loadJobs();
