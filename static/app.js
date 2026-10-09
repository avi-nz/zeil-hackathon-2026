// Candidate interview. Shared helpers ($, api, postJson, escapeHtml, MARK) come from common.js.
let job, sessionId, stream, recorder, chunks = [], recStart, recTimer;
let scenarioIndex = 0, followUps = 0, lastStatus = {};
let screen = "setup", busy = false, awaitingAnswer = false;
let confirming = false;  // candidate is checking our restatement of their answer

function show(name) {
  screen = name;
  for (const s of ["setup", "interview", "result"]) $(`screen-${s}`).classList.toggle("hidden", s !== name);
  voice.render();
}

/* ---------- Setup ---------- */

async function init() {
  let jobs;
  try {
    jobs = await api("/api/jobs");
  } catch (e) {
    $("btn-start").disabled = true;
    $("setup-meta").textContent = e.message;
    return;
  }
  const wanted = new URLSearchParams(location.search).get("job");
  $("job-select").innerHTML = jobs.map((j) => `<option value="${j.id}">${escapeHtml(j.title)}</option>`).join("");
  $("job-select").value = jobs.some((j) => j.id === wanted) ? wanted : jobs[0].id;
  await loadJob($("job-select").value);
}

$("job-select").onchange = async () => {
  const url = new URL(location.href);
  url.searchParams.set("job", $("job-select").value);
  history.replaceState(null, "", url);
  await loadJob($("job-select").value);
};

async function loadJob(id) {
  job = await api(`/api/jobs/${id}`);
  const n = job.competencies.length;
  $("meta").textContent = job.title;
  $("meta").classList.remove("hidden");
  $("setup-role").textContent = job.title;
  $("setup-comps").innerHTML = job.competencies.map((c) => `<li>
      <span class="comp-name">${escapeHtml(c.name)}</span>
      <span class="chip">${scenarioTypeLabel(c.scenario_type)} scenario</span></li>`).join("");
  $("setup-meta").textContent = `${n} scenario${n > 1 ? "s" : ""} · about ${n * 4} minutes · a few follow-up questions on each`;
}

$("btn-start").onclick = async () => {
  $("btn-start").disabled = true;
  try {
    const s = await postJson("/api/session", { job_id: job.id });
    sessionId = s.session_id;
    scenarioIndex = 0;
    followUps = 0;
    $("history").innerHTML = "";
    showCompetency(s.current);
    show("interview");
    setQuestion(s.question, null);
    requestMedia();
  } catch (e) {
    alert(e.message);
  } finally {
    $("btn-start").disabled = false;
  }
};

/* ---------- Camera + recording ---------- */

function camPrompt(message, help = "", button = "Allow camera & mic") {
  $("cam-prompt").classList.toggle("hidden", !message);
  $("cam-msg").textContent = message || "";
  $("cam-help").textContent = help;
  $("btn-allow").textContent = button;
  $("btn-allow").classList.toggle("hidden", !button);
}

async function requestMedia() {
  if (stream) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    camPrompt("Your browser only allows camera access on a secure page.",
      "Open http://localhost:8000 instead, or use “Type instead”.", null);
    return;
  }
  camPrompt("Waiting for permission…", "Look for the pop-up near your address bar and choose Allow.", null);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
      // No camera: carry on with the microphone only.
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { err = e; }
    }
    if (!stream) {
      if (err.name === "NotAllowedError" || err.name === "SecurityError") {
        camPrompt("Camera and microphone access is blocked.",
          "Click the camera icon (or the lock) in the address bar, set Camera and Microphone to Allow, then try again.",
          "Try again");
      } else if (err.name === "NotReadableError") {
        camPrompt("Your camera or mic is being used by another app.", "Close it (e.g. Zoom or Teams), then try again.", "Try again");
      } else {
        camPrompt("No microphone found.", "Connect one and try again, or use “Type instead”.", "Try again");
      }
      setBusy(null);
      return;
    }
  }
  $("cam").srcObject = stream;
  camPrompt(stream.getVideoTracks().length ? null : "No camera found, recording audio only.", "", null);
  setBusy(null);
  maybeAutoRecord();
}

$("btn-allow").onclick = requestMedia;

$("btn-record").onclick = () => (recorder && recorder.state === "recording" ? stopRecording() : startRecording());

function startRecording() {
  if (!stream || busy || (recorder && recorder.state === "recording")) return;
  awaitingAnswer = false;
  speechSynthesis.cancel();
  chunks = [];
  // Only the audio track is recorded and sent; video is preview-only and never leaves the browser.
  recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()));
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => submitAudio(new Blob(chunks, { type: recorder.mimeType }));
  recorder.start();
  recStart = Date.now();
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("rec-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 250);
  $("rec-time").textContent = "0:00";
  $("rec-badge").classList.remove("hidden");
  $("btn-record").classList.add("on");
  $("record-status").textContent = voice.enabled
    ? "Listening… say “That's my answer” when you're done"
    : "Listening… press again when you're done";
  voice.render();
}

function stopRecording() {
  clearInterval(recTimer);
  recorder.stop();
  $("rec-badge").classList.add("hidden");
  $("btn-record").classList.remove("on");
  voice.render();
}

// Gemini reliably accepts WAV, so convert whatever the browser recorded into 16 kHz mono WAV.
async function toWav(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const samples = (await offline.startRendering()).getChannelData(0);

  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([view], { type: "audio/wav" });
}

async function submitAudio(blob) {
  const form = new FormData();
  form.append("session_id", sessionId);
  try {
    setBusy("Transcribing your answer…");
    form.append("audio", await toWav(blob), "answer.wav");
  } catch {
    setBusy(null);
    $("record-status").textContent = "Couldn't read the recording. Please try again.";
    return;
  }
  submit(form);
}

$("btn-type").onclick = () => $("type-box").classList.toggle("hidden");
$("type-box").onsubmit = (e) => {
  e.preventDefault();
  const text = $("type-text").value.trim();
  if (!text) return;
  const form = new FormData();
  form.append("session_id", sessionId);
  form.append("text", text);
  $("type-text").value = "";
  $("type-box").classList.add("hidden");
  submit(form);
};

/* ---------- Interview loop ---------- */

async function submit(form) {
  let error = null;
  const path = confirming ? "/api/confirm" : "/api/answer";
  if (confirming && !form.has("decision")) form.append("decision", "correct");
  const confirmingYes = form.get("decision") === "yes";
  setBusy(confirmingYes ? "Scoring your confirmed answer with Jev…" : confirming ? "Updating our summary…" : "Extracting evidence…");
  const step = setTimeout(() => !confirming && setBusy("Finding missing evidence…"), 2500);
  try {
    const r = await api(path, { method: "POST", body: form });
    if (r.transcript) {
      addTurn(confirming ? "Correction to our summary" : $("question").textContent,
        confirming ? null : $("q-target").dataset.label, r.transcript);
    }
    showEvidence(r.answered, r.target);
    if (r.phase === "confirm") {
      clearTimeout(step);
      showConfirm(r.claims);
    } else if (r.done) {
      hideConfirm();
      setTimeout(() => renderResult(r.result), 1200);
    } else if (r.advanced) {
      hideConfirm();
      // Let the completed panel register before moving to the next scenario.
      clearTimeout(step);
      setBusy("Scenario complete, moving on…");
      await new Promise((resolve) => setTimeout(resolve, 1600));
      scenarioIndex = r.current.index;
      followUps = 0;
      showCompetency(r.current);
      setQuestion(r.next_question, null);
    } else {
      followUps += 1;
      setQuestion(r.next_question, r.answered.dimensions.find((d) => d.id === r.target));
    }
  } catch (e) {
    error = e.message;
  }
  clearTimeout(step);
  setBusy(null);
  if (error) $("record-status").textContent = error;
}

function setBusy(message) {
  busy = !!message;
  $("btn-record").disabled = !!message || !stream;
  $("btn-yes").disabled = $("btn-correct").disabled = !!message;
  $("question").classList.toggle("thinking", !!message);
  $("record-status").textContent = message
    || (confirming ? "Is this what you meant? Confirm it, or correct anything we got wrong"
      : stream ? "Press the red button and answer out loud" : "Allow microphone access to start recording");
}

/* ---------- "What we understood": candidate confirms our restatement ---------- */

function showConfirm(claims) {
  confirming = true;
  awaitingAnswer = false;
  $("q-num").textContent = "Check our understanding";
  $("q-target").classList.add("hidden");
  $("q-target").dataset.label = "";
  $("question").textContent = "Here's what we understood from your answer. Is this right?";
  $("question").classList.add("small");
  $("claims").innerHTML = claims.map((c) => `<li>${escapeHtml(c).replace(/\[unclear:?([^\]]*)\]/gi,
    '<span class="unclear" title="We weren\'t sure we heard this correctly">$1</span>')}</li>`).join("");
  $("claims").classList.remove("hidden");
  $("confirm-actions").classList.remove("hidden");
  $("btn-record").classList.add("hidden");
  speak("Here's what I understood from your answer. Please check it on screen. Is that right?", voice);
  voice.render();
}

function hideConfirm() {
  confirming = false;
  $("question").classList.remove("small");
  $("claims").classList.add("hidden");
  $("confirm-actions").classList.add("hidden");
  $("btn-record").classList.remove("hidden");
}

function confirmYes() {
  if (busy) return;
  const form = new FormData();
  form.append("session_id", sessionId);
  form.append("decision", "yes");
  submit(form);
}

function startCorrection() {
  if (busy) return;
  $("btn-record").classList.remove("hidden");
  if (stream) {
    startRecording();
    $("record-status").textContent = voice.enabled
      ? "Tell us what to change, then say “That's my answer”"
      : "Tell us what to change, then press the button again";
  } else {
    $("type-box").classList.remove("hidden");
  }
}

$("btn-yes").onclick = confirmYes;
$("btn-correct").onclick = startCorrection;

function setQuestion(text, target) {
  const total = job.competencies.length;
  const roleplay = job.competencies[scenarioIndex].kind === "communication";
  const base = (total > 1 ? `Scenario ${scenarioIndex + 1} of ${total}` : "Scenario") + (roleplay ? " · Role-play" : "");
  $("q-num").textContent = followUps ? `${base} · ${roleplay ? "Reply" : "Follow-up"} ${followUps}` : base;
  $("question").textContent = text;
  $("q-target").classList.toggle("hidden", !target);
  $("q-target").dataset.label = target ? target.label : "";
  // In a role-play, naming the missing behaviour would coach the candidate, so just show that it continues.
  $("q-target").textContent = !target ? "" : roleplay ? "Role-play continues" : `Seeking evidence: ${target.label}`;
  readQuestion();
}

// Read the question aloud; in hands-free mode, start recording as soon as it has been read.
function readQuestion() {
  awaitingAnswer = false;
  const text = $("question").textContent;
  speak(text, voice).then(() => {
    if ($("question").textContent !== text || screen !== "interview") return;
    awaitingAnswer = true;
    maybeAutoRecord();
  });
}

function maybeAutoRecord() {
  if (voice.enabled && awaitingAnswer && screen === "interview") startRecording();
}

function addTurn(question, targetLabel, answer) {
  const div = document.createElement("div");
  div.className = "turn";
  div.innerHTML = `<div class="q">${escapeHtml(question)}${targetLabel ? `<span class="tag">→ ${escapeHtml(targetLabel)}</span>` : ""}</div>
    <div class="a">${escapeHtml(answer)}</div>`;
  $("history").prepend(div);
}

// Switch the live panel to a competency (fresh, nothing evidenced yet).
function showCompetency(view) {
  lastStatus = {};
  $("panel-step").textContent = view.total > 1 ? `Competency ${view.index + 1} of ${view.total}` : "Competency";
  $("panel-title").textContent = view.name;
  showEvidence(view, null);
}

function showEvidence(view, target) {
  $("dims").innerHTML = view.dimensions.map((d) => {
    const flash = lastStatus[d.id] && lastStatus[d.id] !== d.status && d.status !== "missing";
    return `<li class="${flash ? "flash" : ""} ${d.id === target ? "targeted" : ""}" title="${escapeHtml(d.quote || d.summary || d.description)}">
      <span class="name">${escapeHtml(d.label)}</span><span class="mark ${d.status}">${MARK[d.status]}</span></li>`;
  }).join("");
  view.dimensions.forEach((d) => (lastStatus[d.id] = d.status));
  setTimeout(() => document.querySelectorAll(".dims li.flash").forEach((li) => li.classList.remove("flash")), 1500);

  const s = view.summary;
  const fraction = s ? s.coverage / s.total : 0;
  $("coverage").textContent = `${Math.round(fraction * 100)}%`;
  $("coverage-bar").style.width = `${fraction * 100}%`;
  if (view.scorer) {
    $("scorer").textContent = view.scorer === "jev" ? "Classified by Jev" : "Jev unavailable, fallback scorer (Gemini)";
  }
}

$("btn-finish").onclick = async () => {
  if (recorder && recorder.state === "recording") return;
  const form = new FormData();
  form.append("session_id", sessionId);
  renderResult(await api("/api/finish", { method: "POST", body: form }));
};

/* ---------- Result ---------- */

function bandClass(band) {
  return band.startsWith("STRONG") ? "" : "weak";
}

// No number is shown without enough evidence: insufficient evidence is not the same as a low score.
function hasScore(summary) {
  return summary && summary.score != null && !summary.band.startsWith("INSUFFICIENT");
}

const VERDICT = { strong: "Strong evidence", partial: "Partial evidence", missing: "Insufficient evidence" };

function pct(p) {
  return `${Math.round(p * 100)}%`;
}

function dimensionRow(d) {
  if (d.status === "missing" && d.present == null) {
    return `<li class="dim-row"><span class="mark missing">○</span><div class="dim-body">
      <div class="dim-head"><span class="name">${escapeHtml(d.label)}</span><span class="verdict missing">Not reached</span></div></div></li>`;
  }
  const evidence = d.quote
    ? `<blockquote class="quote"><span class="label">Candidate's words</span>“${escapeHtml(d.quote)}”</blockquote>`
    : d.status !== "missing" && d.summary
      ? `<p class="ev-summary"><span class="label">Summary</span>${escapeHtml(d.summary)} <em>(no exact quote found)</em></p>`
      : d.status === "missing"
        ? `<p class="ev-summary none">Not demonstrated in the answers. Reported as missing, not scored as poor.</p>` : "";
  const trail = d.trail.length ? `<div class="trail">${d.trail.map((t) =>
    `<span class="step ${t.status}">${escapeHtml(t.label)}${t.targeted ? " · targeted" : ""} <b>${MARK[t.status]}</b></span>`)
    .join('<span class="arrow">→</span>')}</div>` : "";
  const changed = d.raw_status && d.raw_status !== d.status
    ? `<span class="metric">Raw transcript: ${VERDICT[d.raw_status].toLowerCase()}</span>` : "";
  return `<li class="dim-row ${d.review.length ? "flagged" : ""}">
    <span class="mark ${d.status}">${MARK[d.status]}</span>
    <div class="dim-body">
      <div class="dim-head">
        <span class="name">${escapeHtml(d.label)}</span>
        <span class="verdict ${d.status}">${VERDICT[d.status]}</span>
        <span class="r">${d.status === "missing" ? "n/a" : `${d.rating.toFixed(1)} / 5`}</span>
      </div>
      <div class="metrics">
        <span class="metric" title="Jev: probability that explicit evidence is present">
          Evidence present <b>${pct(d.present)}</b><i class="meter"><i style="width:${pct(d.present)}"></i></i></span>
        <span class="metric" title="Jev: position on the 4-level evidence scale (0 = none, 3 = detailed)">
          Strength <b>${d.level.toFixed(1)} / 3</b></span>
        ${d.confidence ? `<span class="metric" title="Jev: how concentrated its strength rating is">Confidence <b>${pct(d.confidence)}</b></span>` : ""}
        ${changed}
      </div>
      ${evidence}
      ${trail}
      ${d.review.map((reason) => `<div class="review">⚑ Needs human review: ${escapeHtml(reason)}</div>`).join("")}
    </div>
  </li>`;
}

function renderResult(r) {
  speechSynthesis.cancel();
  awaitingAnswer = false;
  hideConfirm();
  resetDecision();
  const o = r.overall;
  $("result-title").textContent = r.title;
  $("result-score").textContent = o.score != null ? o.score.toFixed(1) : "n/a";
  $("result-score").parentElement.classList.toggle("none", o.score == null);
  $("result-band").textContent = o.band;
  $("result-band").className = `band ${bandClass(o.band)}`;
  const first = r.competencies[0].summary;
  $("result-coverage").innerHTML = [
    r.competencies.length > 1
      ? `Overall across ${o.assessed} of ${o.total} competencies with enough evidence`
      : first ? `Evidence coverage: ${first.coverage}/${first.total}` : "",
    o.flagged ? `<span class="flag-count">⚑ ${o.flagged} item${o.flagged > 1 ? "s" : ""} need${o.flagged > 1 ? "" : "s"} human review</span>`
      : `<span class="flag-count ok">No items flagged for review</span>`,
  ].filter(Boolean).join(" · ");

  const how = `<div class="how">
    <div class="label">How this was scored</div>
    <ol>
      <li><b>Gemini listened</b> and transcribed the answers. The scorer never hears the voice.</li>
      <li><b>The candidate confirmed</b> our plain-English summary of what they meant, or corrected it.</li>
      <li><b>Jev, a classifier model</b>, judged each evidence dimension and returned probabilities, not an essay.</li>
      <li><b>Score</b> = average strength of the evidenced dimensions. Missing evidence is reported, not scored as poor.</li>
      ${r.competencies.some((c) => c.kind === "communication") ? `<li><b>Communication</b> (opted in by the recruiter for this role)
        is scored from the candidate's own words in a role-play, without restating, and never on accent or voice.</li>` : ""}
    </ol></div>`;

  $("result-comps").innerHTML = how + r.competencies.map((c) => {
    const s = c.summary;
    const band = s ? s.band : "NOT REACHED";
    const status = c.kind === "communication"
      ? `<span class="chip">Scored on the candidate's own words · not restated</span>`
      : c.confirmed
        ? `<span class="chip ok">✓ Summary confirmed by candidate${c.corrections ? ` (${c.corrections} correction${c.corrections > 1 ? "s" : ""})` : ""}</span>`
        : c.turns.length ? `<span class="chip warn">Summary not confirmed</span>` : "";
    const why = c.kind === "communication" && r.communication
      ? `<p class="comm-why"><strong>Why communication is assessed:</strong> included by the recruiter${r.communication.recommended
        ? " on Gemini's recommendation" : ""}. ${escapeHtml(r.communication.rationale)} Judged on clarity, structure,
        listener-friendly language, acknowledging the listener and a clear next step, never on accent, voice or grammar.</p>` : "";
    const rawLine = c.raw_summary && hasScore(c.raw_summary) && hasScore(s)
      ? `<div class="raw-line">Raw transcript ${c.raw_summary.score.toFixed(1)} → confirmed meaning ${s.score.toFixed(1)}</div>` : "";
    return `<div class="comp-block">
      <div class="comp-head">
        <div><div class="label">${scenarioTypeLabel(c.scenario_type)} scenario</div><h3>${escapeHtml(c.name)}</h3>
          <div class="comp-chips">${status}${c.flagged ? `<span class="chip warn">⚑ ${c.flagged} to review</span>` : ""}</div></div>
        <div class="comp-score">${hasScore(s) ? `${s.score.toFixed(1)}<small> / 5</small>` : `<small>No score</small>`}
          <span class="band small ${bandClass(band)}">${band}</span>${rawLine}</div>
      </div>
      ${why}
      <ul class="dim-list">${c.dimensions.map(dimensionRow).join("")}</ul>
      ${c.claims ? `<details><summary>What the candidate confirmed they meant</summary><ul class="claims">${c.claims
        .map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></details>` : ""}
      ${c.turns.length ? `<details><summary>Full transcript</summary><div class="history">${c.turns.map((t) => `<div class="turn">
        <div class="q">${escapeHtml(t.question)}</div><div class="a">${escapeHtml(t.transcript)}</div></div>`).join("")}</div></details>` : ""}
    </div>`;
  }).join("");
  show("result");
}

$("btn-restart").onclick = () => show("setup");

/* ---------- Recruiter decision (mock: nothing is sent anywhere) ---------- */

function decide(decision) {
  const advance = decision === "advance";
  $("decision-buttons").classList.add("hidden");
  $("decision-status").classList.remove("hidden");
  $("decision-status").className = `decision-status ${advance ? "advanced" : "rejected"}`;
  $("decision-text").textContent = advance
    ? "✓ Application moved forward to the next stage"
    : "✕ Applicant rejected. They'll be notified with their evidence summary";
  voice.render();
}

function resetDecision() {
  $("decision-buttons").classList.remove("hidden");
  $("decision-status").classList.add("hidden");
}

$("btn-advance").onclick = () => decide("advance");
$("btn-reject").onclick = () => decide("reject");
$("btn-undo").onclick = resetDecision;

/* ---------- Hands-free voice ---------- */

const START_RE = /\b(start|begin)\b.*\binterview\b|\b(let'?s|i'?m ready to) (start|begin|go)\b/;
const DONE_RE = /\b(that'?s|that is) (my|the) answer\b|\bi'?m (done|finished)\b|\bi am (done|finished)\b|\bsubmit (my |the )?answer\b|\bnext question\b|\bend of (my )?answer\b/;
const END_RE = /\b(end|finish|stop) (the )?interview\b/;
const NO_RE = /\b(no|nope|not quite|not right|that'?s wrong|wrong|correction|change something|correct something|you missed|missed)\b/;
const YES_RE = /\b(yes|yeah|yep|yup|correct|that'?s right|that is right|sounds right|exactly|confirm)\b/;
const REPEAT_RE = /\b(repeat|say) (the|that) question\b|\brepeat that\b/;

function candidateHint() {
  if (screen === "setup") return "Say “Start the interview”";
  if (screen === "result") return "Say “Move the application forward” · “Reject the applicant” · “New interview”";
  if (recorder && recorder.state === "recording") return "Answering… say “That's my answer” when you're finished";
  if (confirming) return "Say “Yes, that's right”, or “No…” to correct something";
  return "Recording starts after the question · “Repeat the question” · “End the interview”";
}

function onCandidatePhrase(text) {
  const t = text.toLowerCase();
  const recording = recorder && recorder.state === "recording";
  if (screen === "setup" && START_RE.test(t)) {
    $("btn-start").click();
  } else if (screen === "interview") {
    if (recording && DONE_RE.test(t)) stopRecording();
    else if (confirming && !recording && !busy && NO_RE.test(t)) startCorrection();
    else if (confirming && !recording && !busy && YES_RE.test(t)) confirmYes();
    else if (!recording && !busy && END_RE.test(t)) $("btn-finish").click();
    else if (!recording && !busy && REPEAT_RE.test(t)) readQuestion();
  } else if (screen === "result") {
    if (/\b(move|moving|push|send)\b.*\b(forward|on|ahead|through)\b|\badvance\b|\bnext stage\b/.test(t)) decide("advance");
    else if (/\breject/.test(t)) decide("reject");
    else if (/\bundo\b/.test(t)) resetDecision();
    else if (/\b(new|another) interview\b/.test(t)) show("setup");
  }
}

const voice = new VoiceControl({ onPhrase: onCandidatePhrase, hint: candidateHint });

init();
