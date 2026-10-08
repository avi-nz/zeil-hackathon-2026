// Candidate interview. Shared helpers ($, api, postJson, escapeHtml, MARK) come from common.js.
let job, sessionId, stream, recorder, chunks = [], recStart, recTimer;
let scenarioIndex = 0, followUps = 0, lastStatus = {};

function show(screen) {
  for (const s of ["setup", "interview", "result"]) $(`screen-${s}`).classList.toggle("hidden", s !== screen);
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
}

$("btn-allow").onclick = requestMedia;

$("btn-record").onclick = () => (recorder && recorder.state === "recording" ? stopRecording() : startRecording());

function startRecording() {
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
  $("record-status").textContent = "Listening… press again when you're done";
}

function stopRecording() {
  clearInterval(recTimer);
  recorder.stop();
  $("rec-badge").classList.add("hidden");
  $("btn-record").classList.remove("on");
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
  setBusy("Extracting evidence…");
  const step = setTimeout(() => setBusy("Finding missing evidence…"), 2500);
  try {
    const r = await api("/api/answer", { method: "POST", body: form });
    addTurn($("question").textContent, $("q-target").dataset.label, r.transcript);
    showEvidence(r.answered, r.target);
    if (r.done) {
      setTimeout(() => renderResult(r.result), 1200);
    } else if (r.advanced) {
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
  $("btn-record").disabled = !!message || !stream;
  $("question").classList.toggle("thinking", !!message);
  $("record-status").textContent = message
    || (stream ? "Press the red button and answer out loud" : "Allow microphone access to start recording");
}

function setQuestion(text, target) {
  const total = job.competencies.length;
  const base = total > 1 ? `Scenario ${scenarioIndex + 1} of ${total}` : "Scenario";
  $("q-num").textContent = followUps ? `${base} · Follow-up ${followUps}` : base;
  $("question").textContent = text;
  $("q-target").classList.toggle("hidden", !target);
  $("q-target").dataset.label = target ? target.label : "";
  $("q-target").textContent = target ? `Seeking evidence: ${target.label}` : "";
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
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
    return `<li class="${flash ? "flash" : ""} ${d.id === target ? "targeted" : ""}" title="${escapeHtml(d.evidence || d.description)}">
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

function renderResult(r) {
  speechSynthesis.cancel();
  const o = r.overall;
  $("result-title").textContent = r.title;
  $("result-score").textContent = o.score != null ? o.score.toFixed(1) : "n/a";
  $("result-score").parentElement.classList.toggle("none", o.score == null);
  $("result-band").textContent = o.band;
  $("result-band").className = `band ${bandClass(o.band)}`;
  const first = r.competencies[0].summary;
  $("result-coverage").textContent = r.competencies.length > 1
    ? `Overall across ${o.assessed} of ${o.total} competencies with enough evidence`
    : (first ? `Evidence coverage: ${first.coverage}/${first.total}` : "");

  $("result-comps").innerHTML = r.competencies.map((c) => {
    const s = c.summary;
    const band = s ? s.band : "NOT REACHED";
    return `<div class="comp-block">
      <div class="comp-head">
        <div><div class="label">${scenarioTypeLabel(c.scenario_type)} scenario</div><h3>${escapeHtml(c.name)}</h3></div>
        <div class="comp-score">${hasScore(s) ? `${s.score.toFixed(1)}<small> / 5</small>` : `<small>No score</small>`}
          <span class="band small ${bandClass(band)}">${band}</span></div>
      </div>
      <ul class="why">${c.dimensions.map((d) => `<li>
        <span class="mark ${d.status}">${MARK[d.status]}</span>
        <div><div class="name">${escapeHtml(d.label)}</div>
          <div class="ev ${d.evidence ? "" : "none"}">${d.status === "missing"
            ? "Insufficient evidence: not demonstrated in the answers (not scored as poor)."
            : escapeHtml(d.evidence || "Evidence present.")}</div></div>
        <span class="r">${d.status === "missing" ? "n/a" : `${d.rating.toFixed(1)} / 5`}</span>
      </li>`).join("")}</ul>
      ${c.turns.length ? `<details><summary>View transcript</summary><div class="history">${c.turns.map((t) => `<div class="turn">
        <div class="q">${escapeHtml(t.question)}</div><div class="a">${escapeHtml(t.transcript)}</div></div>`).join("")}</div></details>` : ""}
    </div>`;
  }).join("");
  show("result");
}

$("btn-restart").onclick = () => show("setup");

init();
