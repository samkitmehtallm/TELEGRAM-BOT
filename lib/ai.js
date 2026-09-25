import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

let cachedVoiceSkill = null;
export function loadVoiceSkill() {
  if (cachedVoiceSkill) return cachedVoiceSkill;
  const path = join(__dirname, "..", "voice-skill.txt");
  cachedVoiceSkill = readFileSync(path, "utf-8");
  return cachedVoiceSkill;
}

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini call failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function callClaude(prompt, { maxTokens = 1024 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude call failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data?.content?.[0]?.text?.trim() || "";
}

// Gemini Flash: fast, cheap, no real judgment needed. Used for triage and keywords.
export async function scoreNote(noteText) {
  const prompt = `You are triaging raw founder notes for a skincare brand (Skinstinct) before they become LinkedIn post drafts.

Score the note below from 0-10 on whether it has enough substance to become a real post: a clear point, a specific observation, data, or a real incident. Logistics reminders, to-do items, and unfinished half-sentences with no point should score low (0-3). Notes with a specific, developable idea should score 6+.

Respond with ONLY a JSON object, no markdown fences: {"score": <number>, "reason": "<one line>"}

NOTE:
"""
${noteText}
"""`;
  const raw = await callGemini(prompt);
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return { score: Number(parsed.score), reason: String(parsed.reason || "") };
  } catch {
    return { score: 0, reason: "Could not parse triage response — treated as reject." };
  }
}

export async function extractKeywords(noteText) {
  const prompt = `Pull 3-5 search keywords from the note below and return them as a single short search phrase suitable for a news search (no quotes, no explanation, just the phrase).

NOTE:
"""
${noteText}
"""`;
  const phrase = await callGemini(prompt);
  return phrase.replace(/["\n]/g, "").trim();
}

// Claude (B1 onward) — holds voice better across a full post. Gemini for L3 demo parity.
export async function draftPost({ note, newsItem }) {
  const voiceSkill = loadVoiceSkill();
  const provider = (process.env.DRAFT_PROVIDER || "gemini").toLowerCase();

  const newsBlock = newsItem
    ? `\nA possibly-relevant current news item was found:\nHeadline: ${newsItem.title}\nSource: ${newsItem.source} · ${newsItem.date}\nLink: ${newsItem.link}\nSummary: ${newsItem.summary}\n\nIf this news item is genuinely relevant, use it to make the post timely. If it doesn't fit naturally, ignore it entirely and don't mention it in the post body.`
    : "";

  const prompt = `You are drafting a LinkedIn post for Meera Pillai, founder of Skinstinct, based on a raw note she captured. Write ONLY the post body — no preamble, no "Here's a draft", no markdown headers.

VOICE PROFILE (follow this precisely — this is how Meera writes, not generic LinkedIn advice):
${voiceSkill}

RAW NOTE FROM MEERA:
"""
${note}
"""
${newsBlock}

Write the LinkedIn post now, in Meera's voice, staying strictly grounded in what the note actually says. Do not invent data, incidents, or numbers that aren't in the note.

After the post body, on its own final line, write exactly one of:
NEWS_USED: yes
NEWS_USED: no
— "yes" only if you actually referenced the news item in the post text above. If no news item was provided, always write "no".`;

  const raw = provider === "gemini" ? await callGemini(prompt) : await callClaude(prompt, { maxTokens: 1200 });

  const match = raw.trim().match(/\n?NEWS_USED:\s*(yes|no)\s*$/i);
  const newsUsed = match ? /yes/i.test(match[1]) : false;
  const text = (match ? raw.slice(0, match.index) : raw).trim();

  return { text, newsUsed };
}
