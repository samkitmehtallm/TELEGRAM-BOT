// Skinstinct content bot — Telegram long-polling bot for Meera.
// A note IS the trigger: it's scored on a 5-criteria rubric, and if it qualifies,
// drafted immediately in Meera's voice — no separate /draft step, no cap.
// Nothing ever reaches LinkedIn from here — Meera is always the final reviewer.

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { XMLParser } from "fast-xml-parser";

// ---------- config ----------
const BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const GEMINI_KEY = requireEnv("GEMINI_API_KEY");
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const DRAFT_PROVIDER = (process.env.DRAFT_PROVIDER || "gemini").toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const QUEUE_THRESHOLD = Number(process.env.QUEUE_THRESHOLD || 7); // out of 10 — drafts immediately once met, no cap
const MIN_WORDS = 350;
const MAX_WORDS = 600;

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
    : null;

const VOICE_GUIDE = readFileSync(new URL("./meera_voice_guide.txt", import.meta.url), "utf-8");

const BANNED_PHRASES = [
  "glow up",
  "self-care journey",
  "clean beauty",
  "nourishing",
  "nourish",
  "glowing skin",
  "game-changer",
  "game changer",
  "must-have",
  "must have",
  "holy grail",
  "skin journey",
  "skincare journey",
  "level up",
  "unlock",
];

const AMERICAN_TO_BRITISH = {
  color: "colour",
  colors: "colours",
  favorite: "favourite",
  moisturizer: "moisturiser",
  moisturizers: "moisturisers",
  flavor: "flavour",
  organize: "organise",
  organized: "organised",
  analyze: "analyse",
  analyzed: "analysed",
  personalize: "personalise",
  fiber: "fibre",
  gray: "grey",
  oxidize: "oxidise",
  oxidizes: "oxidises",
  stabilize: "stabilise",
  stabilized: "stabilised",
  sensitization: "sensitisation",
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---------- Telegram ----------
async function tgCall(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) console.error(`Telegram ${method} failed:`, data);
  return data.result;
}

const sendMessage = (chatId, text) =>
  tgCall("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });

// ---------- Gemini / Claude ----------
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function callGemini(prompt, attempt = 1) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (RETRYABLE_STATUS.has(res.status) && attempt < 3) {
      const delay = attempt * 1500; // 1.5s, then 3s
      console.error(`Gemini ${res.status} (attempt ${attempt}), retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      return callGemini(prompt, attempt + 1);
    }
    throw new Error(`Gemini call failed after ${attempt} attempt(s): ${res.status} ${body}`);
  }
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

async function callClaude(prompt, maxTokens = 1400) {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set but DRAFT_PROVIDER=claude");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data?.content?.[0]?.text || "").trim();
}

// ---------- scoring: 5 criteria x 2 points ----------
async function scoreNote(text) {
  const prompt = `Score this raw founder note from Meera (Skinstinct, a formulation-first skincare brand) on FIVE criteria, 0-2 points each, for whether it's worth developing into a LinkedIn post. Be strict — most notes should NOT max out.

1. specificity — concrete numbers, incidents, names, dates vs. vague generalities
2. mechanism — explains WHY something happens (chemistry, process, cause), not just WHAT happened
3. territory_alignment — fits Meera's known subjects: formulation chemistry, pH, sourcing/supplier verification, batch QC, India-market/climate context, industry transparency (not generic business or lifestyle content)
4. brand_grounding — grounded in Skinstinct's own actual practice/experience, not generic advice anyone could give
5. reader_value — gives the reader something concrete to do or ask, not just an anecdote

Respond with ONLY this JSON, no markdown fences:
{"specificity":0-2,"mechanism":0-2,"territory_alignment":0-2,"brand_grounding":0-2,"reader_value":0-2,"reason":"<one line>"}

NOTE:
"""
${text}
"""`;
  const raw = await callGemini(prompt);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  let c;
  try {
    c = JSON.parse(cleaned);
  } catch {
    c = { specificity: 0, mechanism: 0, territory_alignment: 0, brand_grounding: 0, reader_value: 0, reason: "Could not parse score — treated as 0." };
  }
  const total =
    (c.specificity || 0) + (c.mechanism || 0) + (c.territory_alignment || 0) + (c.brand_grounding || 0) + (c.reader_value || 0);
  return { total, criteria: c, reason: c.reason || "" };
}

function formatScoreBreakdown({ total, criteria, reason }) {
  return (
    `Score: ${total}/10 — ${reason}\n` +
    `  specificity ${criteria.specificity}/2 · mechanism ${criteria.mechanism}/2 · ` +
    `territory ${criteria.territory_alignment}/2 · brand ${criteria.brand_grounding}/2 · reader value ${criteria.reader_value}/2`
  );
}

// ---------- news / sources ----------
async function extractKeywords(text) {
  const phrase = await callGemini(
    `Pull 3-5 search keywords from the note below as one short search phrase (no quotes, no explanation).\n\nNOTE:\n"""\n${text}\n"""`
  );
  return phrase.replace(/["\n]/g, "").trim();
}

async function fetchNews(query) {
  if (!query) return null;
  const url =
    "https://news.google.com/rss/search?" +
    new URLSearchParams({ q: query, hl: "en-IN", gl: "IN", ceid: "IN:en" }).toString();
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SkinstinctBot/1.0)" } });
  if (!res.ok) return null;
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch {
    return null;
  }
  const items = parsed?.rss?.channel?.item;
  const first = Array.isArray(items) ? items[0] : items;
  if (!first) return null;
  const title = String(first.title || "").trim();
  const sourceFromTitle = title.includes(" - ") ? title.split(" - ").pop() : "";
  const source = String(first.source?.["#text"] || first.source || sourceFromTitle || "").trim();
  const headline = sourceFromTitle ? title.slice(0, title.lastIndexOf(" - ")) : title;
  return {
    title: headline,
    source,
    date: first.pubDate ? new Date(first.pubDate).toISOString().slice(0, 10) : "",
    link: String(first.link || "").trim(),
    summary: String(first.description || "").replace(/<[^>]+>/g, "").trim().slice(0, 240),
  };
}

function verifyBlock(newsItem) {
  return (
    "\n\n─────────────────────────────────\n" +
    `NEWS SOURCE: ${newsItem.title}\n` +
    `FROM: ${newsItem.source} · ${newsItem.date}\n` +
    `LINK: ${newsItem.link}\n` +
    "⚠ Check this before publishing — you are the author of this claim\n" +
    "─────────────────────────────────"
  );
}

// ---------- drafting ----------
async function draftPost(note, newsItem, revisionNote) {
  const newsBlock = newsItem
    ? `\nA possibly-relevant current news item was found:\nHeadline: ${newsItem.title}\nSource: ${newsItem.source} · ${newsItem.date}\nSummary: ${newsItem.summary}\n\nUse it only if genuinely relevant; otherwise ignore it entirely.`
    : "";
  const revisionBlock = revisionNote
    ? `\nThis is a REVISION. Meera's feedback on the previous draft: "${revisionNote}". Apply it directly.`
    : "";

  const prompt = `Draft a LinkedIn post for Meera Pillai, founder of Skinstinct, from her raw note. Write ONLY the post body — no preamble, no headers.

VOICE PROFILE (follow precisely):
${VOICE_GUIDE}

RAW NOTE:
"""
${note}
"""
${newsBlock}${revisionBlock}

Target length: ${MIN_WORDS}-${MAX_WORDS} words. No hashtags. No exclamation marks. British/Indian spelling throughout. Stay strictly grounded in the note — do not invent data or incidents.

After the post, on its own final line, write exactly one of:
NEWS_USED: yes
NEWS_USED: no`;

  const raw = DRAFT_PROVIDER === "claude" ? await callClaude(prompt) : await callGemini(prompt);
  const m = raw.trim().match(/\n?NEWS_USED:\s*(yes|no)\s*$/i);
  const newsUsed = !!(m && /yes/i.test(m[1]));
  const text = (m ? raw.slice(0, m.index) : raw).trim();
  return { text, newsUsed };
}

function runChecks(text) {
  const failed = [];
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
    failed.push(`word count ${wordCount} (target ${MIN_WORDS}-${MAX_WORDS})`);
  }
  if (text.includes("#")) failed.push("contains a hashtag");
  if (text.includes("!")) failed.push("contains an exclamation mark");

  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) failed.push(`wellness jargon: "${phrase}"`);
  }
  for (const [us, gb] of Object.entries(AMERICAN_TO_BRITISH)) {
    const re = new RegExp(`\\b${us}\\b`, "i");
    if (re.test(text)) failed.push(`American spelling "${us}" — use "${gb}"`);
  }
  return failed;
}

// ---------- persistence ----------
async function saveNote({ chatId, text, score }) {
  if (!supabase) return null;
  const status = score.total >= QUEUE_THRESHOLD ? "queued" : "rejected";
  const { data, error } = await supabase
    .from("notes")
    .insert({ chat_id: String(chatId), text, score: score.total, reason: score.reason, status, criteria: score.criteria })
    .select()
    .single();
  if (error) console.error("saveNote failed:", error.message);
  return data;
}

async function nextQueuedNote(chatId) {
  if (!supabase) return null;
  const { data } = await supabase
    .from("notes")
    .select("*")
    .eq("chat_id", String(chatId))
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  return data || null;
}

async function markNoteDrafted(noteId) {
  if (!supabase) return;
  await supabase.from("notes").update({ status: "drafted" }).eq("id", noteId);
}

async function saveDraft({ noteId, chatId, draftText, checks }) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("drafts")
    .insert({ note_id: noteId, chat_id: String(chatId), draft_text: draftText, status: "pending", checks })
    .select()
    .single();
  if (error) console.error("saveDraft failed:", error.message);
  return data;
}

async function saveSource({ draftId, newsItem, used }) {
  if (!supabase || !newsItem || !draftId) return;
  await supabase.from("sources").insert({
    draft_id: draftId,
    headline: newsItem.title,
    publication: newsItem.source || null,
    published_date: newsItem.date || null,
    url: newsItem.link || null,
    summary: newsItem.summary || null,
    used_in_draft: !!used,
  });
}

async function latestDraft(chatId) {
  if (!supabase) return null;
  const { data } = await supabase
    .from("drafts")
    .select("*")
    .eq("chat_id", String(chatId))
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data || null;
}

async function updateDraftStatus(draftId, status) {
  if (!supabase) return;
  await supabase.from("drafts").update({ status }).eq("id", draftId);
}

function startOfIsoWeek(d = new Date()) {
  const date = new Date(d);
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

async function draftsUsedThisWeek(chatId) {
  if (!supabase) return 0;
  const { count } = await supabase
    .from("drafts")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", String(chatId))
    .gte("created_at", startOfIsoWeek().toISOString());
  return count || 0;
}

async function queueCount(chatId) {
  if (!supabase) return 0;
  const { count } = await supabase
    .from("notes")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", String(chatId))
    .eq("status", "queued");
  return count || 0;
}

// ---------- command handlers ----------

// Shared by the auto-trigger (a qualifying note arrives) and the manual /draft
// fallback (drafting a note that's sitting queued from before this note was drafted).
async function draftAndSend(chatId, note) {
  let newsItem = null;
  try {
    const keywords = await extractKeywords(note.text);
    newsItem = await fetchNews(keywords);
  } catch (e) {
    console.error("news lookup failed:", e.message);
  }

  const { text: draft, newsUsed } = await draftPost(note.text, newsItem);
  const checks = runChecks(draft);
  const fullReply = draft + (newsUsed ? verifyBlock(newsItem) : "");

  const savedDraft = await saveDraft({ noteId: note.id, chatId, draftText: fullReply, checks });
  if (newsItem) await saveSource({ draftId: savedDraft?.id, newsItem, used: newsUsed });
  await markNoteDrafted(note.id);

  const checksBlock = checks.length ? `\n\nFailed checks:\n- ${checks.join("\n- ")}` : "\n\nAll checks passed.";
  await sendMessage(chatId, `${fullReply}${checksBlock}\n\n— Reply APPROVE/REJECT, or /revise <feedback> to adjust this draft.`);
}

// A note IS the trigger: score it, and if it qualifies, draft it immediately — no
// separate /draft step, no weekly cap.
async function handleNote(chatId, text) {
  const score = await scoreNote(text);
  const note = await saveNote({ chatId, text, score });

  if (score.total < QUEUE_THRESHOLD) {
    await sendMessage(chatId, `${formatScoreBreakdown(score)}\n\nNot drafted — send something with a clearer point.`);
    return;
  }
  await sendMessage(chatId, formatScoreBreakdown(score));
  await draftAndSend(chatId, note);
}

// Manual fallback: drafts the oldest note still sitting in "queued" status (e.g. one
// that errored out before auto-drafting could finish). Not part of the normal flow.
async function handleDraftCommand(chatId) {
  const note = await nextQueuedNote(chatId);
  if (!note) {
    await sendMessage(chatId, "Nothing queued — notes draft automatically as soon as they score high enough.");
    return;
  }
  await draftAndSend(chatId, note);
}

async function handleReviseCommand(chatId, feedback) {
  if (!feedback) {
    await sendMessage(chatId, "Usage: /revise <what to change> — e.g. /revise make the opening punchier");
    return;
  }
  const draft = await latestDraft(chatId);
  if (!draft) {
    await sendMessage(chatId, "No draft on file yet for this chat — run /draft first.");
    return;
  }
  const { data: note } = supabase ? await supabase.from("notes").select("*").eq("id", draft.note_id).single() : { data: null };
  const originalNote = note?.text || draft.draft_text;

  const { text: revised, newsUsed } = await draftPost(originalNote, null, feedback);
  const checks = runChecks(revised);
  const savedDraft = await saveDraft({ noteId: draft.note_id, chatId, draftText: revised, checks });
  void newsUsed;
  void savedDraft;

  const checksBlock = checks.length ? `\n\nFailed checks:\n- ${checks.join("\n- ")}` : "\n\nAll checks passed.";
  await sendMessage(chatId, `Revised:\n\n${revised}${checksBlock}\n\n— Reply APPROVE/REJECT, or /revise again.`);
}

async function handleScoreCommand(chatId, text) {
  if (text) {
    const score = await scoreNote(text);
    await sendMessage(chatId, `${formatScoreBreakdown(score)}\n\n(dry run — not queued)`);
    return;
  }
  const note = await nextQueuedNote(chatId);
  if (!note) {
    await sendMessage(chatId, "Nothing queued. Send a note, or use /score <text> to test one without queuing it.");
    return;
  }
  await sendMessage(chatId, `Next in queue:\n"${note.text.slice(0, 200)}${note.text.length > 200 ? "..." : ""}"\n\nScore: ${note.score}/10 — ${note.reason}`);
}

async function handleQueueCommand(chatId) {
  if (!supabase) {
    await sendMessage(chatId, "Memory layer not configured — queue isn't tracked.");
    return;
  }
  const { data } = await supabase
    .from("notes")
    .select("id, text, score, created_at")
    .eq("chat_id", String(chatId))
    .eq("status", "queued")
    .order("created_at", { ascending: true });

  if (!data || data.length === 0) {
    await sendMessage(chatId, "Queue's empty.");
    return;
  }
  const lines = data.map((n, i) => `${i + 1}. [${n.score}/10] ${n.text.slice(0, 70)}${n.text.length > 70 ? "..." : ""}`);
  await sendMessage(chatId, `Queued (${data.length}):\n\n${lines.join("\n")}`);
}

async function handleStatusCommand(chatId) {
  const used = await draftsUsedThisWeek(chatId);
  const queued = await queueCount(chatId);
  await sendMessage(
    chatId,
    `Drafts this week: ${used}\nStuck in queue (not yet auto-drafted): ${queued}\nThreshold to draft: ${QUEUE_THRESHOLD}/10\nDraft model: ${DRAFT_PROVIDER}`
  );
}

async function handleApproveReject(chatId, decision) {
  const draft = await latestDraft(chatId);
  if (!draft) {
    await sendMessage(chatId, `Marked ${decision}, but no draft was on file for this chat.`);
    return;
  }
  await updateDraftStatus(draft.id, decision);
  await sendMessage(chatId, `Got it — marked ${decision}.`);
}

// ---------- update router ----------
async function handleUpdate(update) {
  const msg = update.message || update.channel_post;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text) {
    console.log(`[${chatId}] non-text update, skipped`);
    return;
  }

  try {
    if (text === "/start") {
      await sendMessage(
        chatId,
        "Skinstinct content bot is live. Send a note — if it scores high enough it drafts immediately, no extra step.\n\n" +
          "/revise <feedback> — adjust the last draft\n/score [text] — check a score without drafting\n" +
          "/queue — any notes stuck without a draft\n/status — recent activity\n\nNothing publishes without you."
      );
      return;
    }
    if (text === "/queue") return await handleQueueCommand(chatId);
    if (text === "/draft") return await handleDraftCommand(chatId);
    if (text.startsWith("/revise")) return await handleReviseCommand(chatId, text.replace(/^\/revise\s*/i, "").trim());
    if (text.startsWith("/score")) return await handleScoreCommand(chatId, text.replace(/^\/score\s*/i, "").trim());
    if (text === "/status") return await handleStatusCommand(chatId);
    if (/^APPROVE$/i.test(text)) return await handleApproveReject(chatId, "approved");
    if (/^REJECT$/i.test(text)) return await handleApproveReject(chatId, "rejected");

    return await handleNote(chatId, text);
  } catch (e) {
    // The user must never be left with silence — always tell them something broke.
    console.error(`[${chatId}] handler failed:`, e.message);
    await sendMessage(chatId, `Something went wrong processing that (${e.message.slice(0, 120)}). Try again in a moment.`).catch(() => {});
  }
}

// ---------- long-polling loop ----------
async function getUpdates(offset) {
  const params = new URLSearchParams({ timeout: "25" });
  if (offset !== undefined) params.set("offset", String(offset));
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?${params}`, {
    signal: AbortSignal.timeout(35000),
  });
  const data = await res.json();
  return data.result || [];
}

async function main() {
  console.log("Skinstinct content bot starting (long polling)...");
  let offset;
  while (true) {
    let updates;
    try {
      updates = await getUpdates(offset);
    } catch (e) {
      console.error("poll error (recovered):", e.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const upd of updates) {
      offset = upd.update_id + 1;
      try {
        await handleUpdate(upd);
      } catch (e) {
        console.error(`error handling update ${upd.update_id} (recovered):`, e.message);
      }
    }
  }
}

main().catch((e) => {
  console.error("Fatal error, bot stopped:", e);
  process.exit(1);
});
