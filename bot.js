// Skinstinct content bot — Telegram long-polling bot for Meera.
// A note IS the trigger. Every note gets a post: sources are scraped, a draft is written
// in her voice, style rules are checked, and the finished draft is scored on source
// validation, context and brand recall. The score grades the output — it never blocks it.
// Nothing ever reaches LinkedIn from here — Meera is always the final reviewer.

import { readFileSync, realpathSync } from "fs";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { XMLParser } from "fast-xml-parser";

// ---------- config ----------
const BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const GEMINI_KEY = requireEnv("GEMINI_API_KEY");
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const DRAFT_PROVIDER = (process.env.DRAFT_PROVIDER || "gemini").toLowerCase();
// Ordered fallback chain. The "-latest" aliases get congested in bursts (503) and the
// free tier exhausts quota on pro models (429) — so a single model is a single point of
// failure. Tried in order; first one that answers wins.
const GEMINI_MODELS = (
  process.env.GEMINI_MODELS ||
  "gemini-flash-latest,gemini-3.6-flash,gemini-3.1-flash-lite,gemini-flash-lite-latest"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const SOURCES_PER_QUERY = Number(process.env.SOURCES_PER_QUERY || 3);
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

// Telegram rejects anything over 4096 characters outright, and a draft plus its source
// list routinely exceeds that — so split on paragraph boundaries and send in order.
const TG_MAX_CHARS = 3900;

async function sendLongMessage(chatId, text) {
  if (text.length <= TG_MAX_CHARS) return sendMessage(chatId, text);

  const chunks = [];
  let current = "";
  for (const para of text.split("\n\n")) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > TG_MAX_CHARS) {
      if (current) chunks.push(current);
      // A single paragraph longer than the limit still has to be cut somewhere.
      if (para.length > TG_MAX_CHARS) {
        for (let i = 0; i < para.length; i += TG_MAX_CHARS) chunks.push(para.slice(i, i + TG_MAX_CHARS));
        current = "";
      } else {
        current = para;
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) await sendMessage(chatId, chunk);
}

// ---------- Gemini / Claude ----------
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function callGeminiModel(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

// Walks the model chain: retries a model while its errors look transient, then falls
// through to the next model. A 404 (model not available on this key) is skipped at once.
async function callGemini(prompt) {
  const failures = [];
  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callGeminiModel(model, prompt);
      } catch (e) {
        const status = e.status;
        if (status === 404) {
          failures.push(`${model}: not available`);
          break; // no point retrying a model this key can't see
        }
        const retryable = status === undefined || RETRYABLE_STATUS.has(status);
        if (retryable && attempt < 2) {
          console.error(`Gemini ${model} ${status || "network"} (attempt ${attempt}), retrying...`);
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        failures.push(`${model}: ${e.message.split("\n")[0]}`);
        break; // move on to the next model in the chain
      }
    }
  }
  throw new Error(`All Gemini models failed — ${failures.join(" | ")}`);
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

// ---------- scoring ----------
// Scores the PRODUCED DRAFT, not the incoming note. A note is never rejected — every
// note gets a post. The score tells Meera how strong the post is on the three things
// that matter when publishing under her own name as a founder.
async function scoreDraft(draft, sources = []) {
  const sourceList = sources.length
    ? sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.source} (${s.date})`).join("\n")
    : "(no external sources were found for this post)";

  const prompt = `Score this LinkedIn post drafted for Meera Pillai, founder of Skinstinct (a formulation-first skincare brand), on THREE criteria, 0-10 each.

1. source_validation — are the factual claims verifiable and properly supported? Claims backed by her own documented practice (batch data, CoA, stability testing, supplier logs) or by a cited source score high. Unsupported assertions, invented numbers, or vague appeals to "studies" score low.
2. context — does the post situate its point in the real current landscape (Indian market conditions, regulation, category dynamics, what the industry actually does) rather than floating free of time and place?
3. brand_recall — would a reader come away remembering Meera and Skinstinct specifically? Her voice (precise, calibrated, self-implicating, anti-marketing) and her positioning should be unmistakable. Generic industry commentary anyone could have written scores low.

SOURCES AVAILABLE TO THE POST:
${sourceList}

POST:
"""
${draft}
"""

Respond with ONLY this JSON, no markdown fences:
{"source_validation":0-10,"context":0-10,"brand_recall":0-10,"reason":"<one line naming the weakest criterion and how to lift it>"}`;

  const raw = await callGemini(prompt);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  let c;
  try {
    c = JSON.parse(cleaned);
  } catch {
    c = { source_validation: 0, context: 0, brand_recall: 0, reason: "Could not parse score." };
  }
  const overall =
    Math.round((((Number(c.source_validation) || 0) + (Number(c.context) || 0) + (Number(c.brand_recall) || 0)) / 3) * 10) / 10;
  return { overall, criteria: c, reason: c.reason || "" };
}

function formatScoreBreakdown({ overall, criteria, reason }) {
  return (
    `Score: ${overall}/10 — ${reason}\n` +
    `  source validation ${criteria.source_validation}/10 · context ${criteria.context}/10 · brand recall ${criteria.brand_recall}/10`
  );
}

// ---------- news / sources ----------
// Two or three angles beat one: a note about supplier specs might have nothing in the
// news under its own words, but plenty under the regulation or category angle.
async function buildSearchQueries(text) {
  const raw = await callGemini(
    `From the founder's note below, write 3 different news-search queries that would surface genuinely relevant, citable articles for a LinkedIn post about it. Vary the angle: one on the specific topic, one on the wider industry/regulatory context, one on the Indian market angle. Each query 3-6 words, no quotes.

Return ONLY the three queries, one per line, nothing else.

NOTE:
"""
${text}
"""`
  );
  return raw
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").replace(/["']/g, "").trim())
    .filter((l) => l.length > 2)
    .slice(0, 3);
}

function parseRssItem(item) {
  const title = String(item.title || "").trim();
  const sourceFromTitle = title.includes(" - ") ? title.split(" - ").pop() : "";
  const source = String(item.source?.["#text"] || item.source || sourceFromTitle || "").trim();
  const headline = sourceFromTitle ? title.slice(0, title.lastIndexOf(" - ")) : title;
  return {
    title: headline,
    source,
    date: item.pubDate ? new Date(item.pubDate).toISOString().slice(0, 10) : "",
    link: String(item.link || "").trim(),
    summary: String(item.description || "").replace(/<[^>]+>/g, "").trim().slice(0, 240),
  };
}

// Scrapes several candidate sources per query, across multiple queries, so the draft has
// real material to work with instead of a single top hit that's usually a listicle.
async function fetchSources(queries, perQuery = SOURCES_PER_QUERY) {
  const collected = [];
  const seen = new Set();

  for (const query of queries.filter(Boolean)) {
    const url =
      "https://news.google.com/rss/search?" +
      new URLSearchParams({ q: query, hl: "en-IN", gl: "IN", ceid: "IN:en" }).toString();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SkinstinctBot/1.0)" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const parsed = new XMLParser({ ignoreAttributes: false }).parse(await res.text());
      const items = parsed?.rss?.channel?.item;
      const list = Array.isArray(items) ? items : items ? [items] : [];
      for (const item of list.slice(0, perQuery)) {
        const parsedItem = parseRssItem(item);
        if (!parsedItem.title || seen.has(parsedItem.title)) continue;
        seen.add(parsedItem.title);
        collected.push(parsedItem);
      }
    } catch (e) {
      console.error(`source fetch failed for "${query}":`, e.message);
    }
  }
  return collected;
}

// Every source the bot found is listed under the post — used or not — because Meera
// publishes under her own name and needs to check anything she cites.
function sourcesBlock(sources, usedIndexes) {
  if (!sources.length) return "\n\n─── SOURCES ───\nNone found for this one — the post stands on your own material.";
  const lines = sources.map((s, i) => {
    const mark = usedIndexes.includes(i + 1) ? "✓ cited" : "  not cited";
    return `${mark} [${i + 1}] ${s.title}\n     ${s.source} · ${s.date}\n     ${s.link}`;
  });
  return (
    "\n\n─── SOURCES ───\n" +
    lines.join("\n") +
    "\n⚠ Verify anything cited before publishing — you are the author of the claim."
  );
}

// ---------- drafting ----------
async function draftPost(note, sources = [], revisionNote) {
  const sourceBlock = sources.length
    ? `\nSOURCES SCRAPED FOR THIS POST (cite by number where they genuinely strengthen the argument; ignore any that don't fit — never force one in):\n` +
      sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.source} (${s.date})\n    ${s.summary}`).join("\n")
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
${sourceBlock}${revisionBlock}

This note is raw thinking — it may be a half-formed musing rather than a finished argument. Your job is to find the strongest publishable angle inside it and build the post around that. If the note says she's unsure what the angle is, pick the sharpest one available and commit to it.

Target length: ${MIN_WORDS}-${MAX_WORDS} words. No hashtags. No exclamation marks. British/Indian spelling throughout. Do not invent data, numbers, or incidents that aren't in the note or the sources.

After the post, on its own final line, list which source numbers you actually cited:
SOURCES_CITED: 1,3
(or "SOURCES_CITED: none" if you cited none)`;

  const raw = DRAFT_PROVIDER === "claude" ? await callClaude(prompt) : await callGemini(prompt);
  const m = raw.trim().match(/\n?SOURCES_CITED:\s*([^\n]*)\s*$/i);
  const citedRaw = m ? m[1].trim() : "none";
  const usedIndexes = /none/i.test(citedRaw)
    ? []
    : citedRaw
        .split(/[,\s]+/)
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= sources.length);
  const text = (m ? raw.slice(0, m.index) : raw).trim();
  return { text, usedIndexes };
}

function runChecks(text, sourceNote = "") {
  const failed = [];
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
    failed.push(`word count ${wordCount} (target ${MIN_WORDS}-${MAX_WORDS})`);
  }
  if (text.includes("#")) failed.push("contains a hashtag");
  if (text.includes("!")) failed.push("contains an exclamation mark");

  const lower = text.toLowerCase();
  const noteLower = sourceNote.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    // If Meera used the phrase in her own note, she's discussing the term deliberately
    // (e.g. a post critiquing "clean beauty") — flagging it would be noise.
    if (lower.includes(phrase) && !noteLower.includes(phrase)) failed.push(`wellness jargon: "${phrase}"`);
  }
  for (const [us, gb] of Object.entries(AMERICAN_TO_BRITISH)) {
    const re = new RegExp(`\\b${us}\\b`, "i");
    if (re.test(text)) failed.push(`American spelling "${us}" — use "${gb}"`);
  }
  return failed;
}

// ---------- persistence ----------
async function saveNote({ chatId, text }) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("notes")
    .insert({ chat_id: String(chatId), text, status: "queued" })
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

async function saveDraft({ noteId, chatId, draftText, checks, score }) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("drafts")
    .insert({
      note_id: noteId,
      chat_id: String(chatId),
      draft_text: draftText,
      status: "pending",
      checks,
      score: score?.overall ?? null,
      criteria: score?.criteria ?? null,
    })
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

// The full pipeline: scrape sources → draft → style checks → score the draft.
// Every note produces a post. The score grades the output; it never blocks it.
async function draftAndSend(chatId, note) {
  let sources = [];
  try {
    const queries = await buildSearchQueries(note.text);
    sources = await fetchSources(queries);
    console.log(`[${chatId}] scraped ${sources.length} source(s) from ${queries.length} queries`);
  } catch (e) {
    console.error("source scraping failed:", e.message);
  }

  const { text: draft, usedIndexes } = await draftPost(note.text, sources);
  const checks = runChecks(draft, note.text);
  const score = await scoreDraft(draft, sources);

  const checksBlock = checks.length ? `\n\nStyle checks failed:\n- ${checks.join("\n- ")}` : "\n\nAll style checks passed.";
  const fullReply = `${draft}${sourcesBlock(sources, usedIndexes)}${checksBlock}\n\n${formatScoreBreakdown(score)}\n\n— Reply APPROVE/REJECT, or /revise <feedback> to adjust.`;

  const savedDraft = await saveDraft({ noteId: note.id, chatId, draftText: draft, checks, score });
  for (const [i, source] of sources.entries()) {
    await saveSource({ draftId: savedDraft?.id, newsItem: source, used: usedIndexes.includes(i + 1) });
  }
  await markNoteDrafted(note.id);

  await sendLongMessage(chatId, fullReply);
}

// A note IS the trigger — it always gets drafted, never rejected.
async function handleNote(chatId, text) {
  const note = await saveNote({ chatId, text });
  await draftAndSend(chatId, note);
}

// Manual fallback for a note that errored out before its draft completed.
async function handleDraftCommand(chatId) {
  const note = await nextQueuedNote(chatId);
  if (!note) {
    await sendMessage(chatId, "Nothing pending — every note drafts automatically when you send it.");
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

  const { text: revised } = await draftPost(originalNote, [], feedback);
  const checks = runChecks(revised, originalNote);
  const score = await scoreDraft(revised, []);
  await saveDraft({ noteId: draft.note_id, chatId, draftText: revised, checks, score });

  const checksBlock = checks.length ? `\n\nStyle checks failed:\n- ${checks.join("\n- ")}` : "\n\nAll style checks passed.";
  await sendLongMessage(chatId, `Revised:\n\n${revised}${checksBlock}\n\n${formatScoreBreakdown(score)}\n\n— Reply APPROVE/REJECT, or /revise again.`);
}

// Scores an existing piece of text as if it were a finished post — useful for checking
// something you've already written by hand.
async function handleScoreCommand(chatId, text) {
  if (!text) {
    await sendMessage(chatId, "Usage: /score <text> — scores any post text on source validation, context and brand recall.");
    return;
  }
  const score = await scoreDraft(text, []);
  await sendMessage(chatId, formatScoreBreakdown(score));
}

async function handleQueueCommand(chatId) {
  if (!supabase) {
    await sendMessage(chatId, "Memory layer not configured — nothing is tracked.");
    return;
  }
  const { data } = await supabase
    .from("notes")
    .select("id, text, created_at")
    .eq("chat_id", String(chatId))
    .eq("status", "queued")
    .order("created_at", { ascending: true });

  if (!data || data.length === 0) {
    await sendMessage(chatId, "Nothing pending — every note you send gets drafted straight away.");
    return;
  }
  const lines = data.map((n, i) => `${i + 1}. ${n.text.slice(0, 70)}${n.text.length > 70 ? "..." : ""}`);
  await sendMessage(chatId, `Pending, not yet drafted (${data.length}):\n\n${lines.join("\n")}\n\nSend /draft to process.`);
}

async function handleStatusCommand(chatId) {
  const used = await draftsUsedThisWeek(chatId);
  const pending = await queueCount(chatId);
  await sendMessage(
    chatId,
    `Drafts this week: ${used}\nPending (errored, not drafted): ${pending}\nDraft model: ${DRAFT_PROVIDER}\nScoring: source validation · context · brand recall`
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
        "Skinstinct content bot is live. Send any note — raw, half-formed, whatever. You get back:\n" +
          "• a LinkedIn post in your voice\n• the sources it scraped (cited or not, all listed to verify)\n" +
          "• style checks\n• a score on source validation, context and brand recall\n\n" +
          "/revise <feedback> — adjust the last draft\n/score <text> — score any text you've written\n" +
          "/status — recent activity\n\nEvery note gets a post. Nothing publishes without you."
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
// Telegram's own long-poll timeout is TG_POLL_TIMEOUT seconds; the client-side abort
// must sit comfortably above that, or a client abort can race Telegram's server-side
// connection teardown and produce a self-inflicted 409 ("terminated by other getUpdates
// request") on the very next call — the bot conflicting with its own previous request.
const TG_POLL_TIMEOUT = 20; // seconds Telegram holds the connection open
const CLIENT_ABORT_MS = 50000; // well above TG_POLL_TIMEOUT, generous margin for network jitter

async function getUpdates(offset) {
  const params = new URLSearchParams({ timeout: String(TG_POLL_TIMEOUT) });
  if (offset !== undefined) params.set("offset", String(offset));
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?${params}`, {
    signal: AbortSignal.timeout(CLIENT_ABORT_MS),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`getUpdates failed: ${data.error_code} ${data.description}`);
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
      // A timeout/abort/409 means a connection may still be settling server-side —
      // give it real time to clear instead of immediately reconnecting into it.
      const isConflict = /409|conflict/i.test(e.message);
      const delay = isConflict ? 8000 : 4000;
      console.error(`poll error (recovered, retrying in ${delay}ms):`, e.message);
      await new Promise((r) => setTimeout(r, delay));
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

// Only start polling when run directly (`node bot.js`). Importing this file — for a
// one-off test of the real scoring/drafting path — must not open a second long-poll
// connection, since Telegram allows only one per bot and the two would conflict.
const isEntryPoint = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch((e) => {
    console.error("Fatal error, bot stopped:", e);
    process.exit(1);
  });
}

export {
  scoreDraft,
  draftPost,
  runChecks,
  formatScoreBreakdown,
  draftAndSend,
  sendMessage,
  sendLongMessage,
  callGemini,
  buildSearchQueries,
  fetchSources,
  sourcesBlock,
};
