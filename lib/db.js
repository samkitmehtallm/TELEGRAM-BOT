import { createClient } from "@supabase/supabase-js";

let client = null;
function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return null; // memory layer is optional — pipeline still works without it
  if (!client) client = createClient(url, key);
  return client;
}

export async function saveNote({ chatId, text, score, reason }) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db
    .from("notes")
    .insert({ chat_id: String(chatId), text, score, reason })
    .select()
    .single();
  if (error) {
    console.error("saveNote failed:", error.message);
    return null;
  }
  return data;
}

export async function saveDraft({ noteId, chatId, draft }) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db
    .from("drafts")
    .insert({
      note_id: noteId,
      chat_id: String(chatId),
      draft_text: draft,
      status: "pending",
    })
    .select()
    .single();
  if (error) {
    console.error("saveDraft failed:", error.message);
    return null;
  }
  return data;
}

// Stores every news source surfaced for a draft, not just the one that got cited —
// used_in_draft tells you which. This is the "sources" table.
export async function saveSource({ draftId, newsItem, used }) {
  const db = getClient();
  if (!db || !newsItem || !draftId) return null;
  const { data, error } = await db
    .from("sources")
    .insert({
      draft_id: draftId,
      headline: newsItem.title,
      publication: newsItem.source || null,
      published_date: newsItem.date || null,
      url: newsItem.link || null,
      summary: newsItem.summary || null,
      used_in_draft: !!used,
    })
    .select()
    .single();
  if (error) {
    console.error("saveSource failed:", error.message);
    return null;
  }
  return data;
}

export async function updateLatestDraftStatus(chatId, status) {
  const db = getClient();
  if (!db) return null;
  const { data: latest } = await db
    .from("drafts")
    .select("id")
    .eq("chat_id", String(chatId))
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (!latest) return null;
  const { error } = await db.from("drafts").update({ status }).eq("id", latest.id);
  if (error) console.error("updateLatestDraftStatus failed:", error.message);
  return latest.id;
}
