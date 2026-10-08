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
