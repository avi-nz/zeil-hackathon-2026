// Shared by the candidate (index.html) and recruiter (recruiter.html) pages.
const $ = (id) => document.getElementById(id);
const MARK = { strong: "✓", partial: "◐", missing: "○" };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Served by main.py on :8000 the API is same-origin; opened any other way (IDE preview, file://) it is on :8000.
const API = location.protocol.startsWith("http") && location.port === "8000" ? "" : "http://localhost:8000";

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, options);
  } catch {
    throw new Error("Can't reach the interview server. Start it with `.venv/bin/python main.py` and open http://localhost:8000");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `Request failed (${res.status})`);
  return body;
}

function postJson(path, data) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

function scenarioTypeLabel(type) {
  return type === "situational" ? "Situational" : "Behavioural";
}

/* ---------- Hands-free voice control ----------
   Chrome's built-in speech recognition listens continuously and shows a live caption; each finished phrase is
   passed to the page, which decides what it means. Voice mode is remembered across pages, so a demo can flow from
   the recruiter page to the candidate interview without touching anything. */

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
const VOICE_KEY = "zeil-voice";

function voicePreferred() {
  if (new URLSearchParams(location.search).get("voice") === "1") return true;
  try { return localStorage.getItem(VOICE_KEY) === "1"; } catch { return false; }
}

class VoiceControl {
  constructor({ onPhrase, hint }) {
    this.onPhrase = onPhrase;
    this.hint = hint;
    this.enabled = false;
    this.muted = false;  // ignore what we hear while the page itself is speaking
    this.buildBar();
    if (!SpeechRecognitionImpl) {
      this.setStatus("Voice control needs Google Chrome");
      this.toggle.disabled = true;
      return;
    }
    this.rec = new SpeechRecognitionImpl();
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.lang = navigator.language || "en-US";
    this.rec.onresult = (e) => this.handleResult(e);
    this.rec.onerror = (e) => this.handleError(e);
    this.rec.onend = () => { if (this.enabled) setTimeout(() => this.listen(), 250); };
    if (voicePreferred()) this.start();
    else this.render();
  }

  buildBar() {
    const bar = document.createElement("div");
    bar.className = "voice-bar";
    bar.innerHTML = `
      <button class="voice-toggle" type="button" aria-label="Toggle voice control"><span class="voice-dot"></span></button>
      <div class="voice-text">
        <div class="voice-caption"></div>
        <div class="voice-hint"></div>
      </div>`;
    document.body.appendChild(bar);
    this.bar = bar;
    this.toggle = bar.querySelector(".voice-toggle");
    this.caption = bar.querySelector(".voice-caption");
    this.hintEl = bar.querySelector(".voice-hint");
    this.toggle.onclick = () => (this.enabled ? this.stop() : this.start());
  }

  start() {
    this.enabled = true;
    try { localStorage.setItem(VOICE_KEY, "1"); } catch {}
    this.listen();
    this.setStatus("Listening…");
    this.render();
  }

  stop() {
    this.enabled = false;
    try { localStorage.setItem(VOICE_KEY, "0"); } catch {}
    try { this.rec.stop(); } catch {}
    this.setStatus("Voice control is off. Click the mic to go hands-free");
    this.render();
  }

  listen() {
    try { this.rec.start(); } catch { /* already listening */ }
  }

  handleResult(e) {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim();
      if (e.results[i].isFinal) {
        if (text && !this.muted) {
          this.setCaption(`“${text}”`, false);
          this.onPhrase(text);
        }
      } else {
        interim += `${text} `;
      }
    }
    if (interim.trim() && !this.muted) this.setCaption(`${interim.trim()}…`, true);
  }

  handleError(e) {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      this.enabled = false;
      this.setStatus("Microphone blocked: allow it in the address bar, then click the mic");
    } else if (e.error === "network") {
      this.setStatus("Speech recognition needs an internet connection");
    }
    this.render();
  }

  setCaption(text, interim) {
    this.caption.textContent = text;
    this.caption.classList.toggle("interim", interim);
  }

  setStatus(text) {
    this.caption.textContent = text;
    this.caption.classList.remove("interim");
  }

  render() {
    this.bar.classList.toggle("on", this.enabled);
    if (!this.caption.textContent) this.setStatus("Voice control is off. Click the mic to go hands-free");
    this.hintEl.textContent = this.enabled ? this.hint() : "";
  }
}

// Read text aloud; resolves when finished (or straight away if the browser blocks speech without a click).
function speak(text, voice) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (voice) setTimeout(() => (voice.muted = false), 300);
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    // Chrome sometimes never fires onend for long text; fall back to an estimate.
    setTimeout(done, 1500 + text.split(/\s+/).length * 420);
    if (voice) voice.muted = true;
    speechSynthesis.speak(u);
  });
}
