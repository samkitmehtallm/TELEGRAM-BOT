import { sendMessage } from "../lib/telegram.js";
import { scoreNote, extractKeywords, draftPost } from "../lib/ai.js";
import { fetchNews } from "../lib/news.js";
import { saveNote, saveDraft, saveSource, updateLatestDraftStatus } from "../lib/db.js";

const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD || 6);

function verifyBlock(newsItem) {
  if (!newsItem) return "";
  return `\n\n─────────────────────────────────\nNEWS SOURCE: ${newsItem.title}\nFROM: ${newsItem.source} · ${newsItem.date}\nLINK: ${newsItem.link}\n⚠ Check this before publishing — you are the author of this claim\n─────────────────────────────────`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).send("Skinstinct content engine webhook is live.");
    return;
  }

  try {
    const update = req.body;
    const message = update?.message;
    const chatId = message?.chat?.id;
    const text = (message?.text || "").trim();

    if (!chatId || !text) {
      res.status(200).json({ ok: true });
      return;
    }

    // Meera reviewing a prior draft, not sending a new note.
    if (/^APPROVE$/i.test(text) || /^REJECT$/i.test(text)) {
      const status = /^APPROVE$/i.test(text) ? "approved" : "rejected";
      await updateLatestDraftStatus(chatId, status);
      await sendMessage(chatId, `Got it — marked ${status}.`);
      res.status(200).json({ ok: true });
      return;
    }

    // Checkpoint B1·1 — score before drafting.
    const { score, reason } = await scoreNote(text);
    const note = await saveNote({ chatId, text, score, reason });

    if (score < SCORE_THRESHOLD) {
      await sendMessage(
        chatId,
        `Skipped this one (score ${score}/10) — ${reason}\n\nSend something with a clearer point and I'll draft it.`
      );
      res.status(200).json({ ok: true });
      return;
    }

    // Checkpoint B1·2 — news angle.
    let newsItem = null;
    try {
      const keywords = await extractKeywords(text);
      newsItem = await fetchNews(keywords);
    } catch (err) {
      console.error("News lookup failed, continuing without it:", err.message);
    }

    const { text: draft, newsUsed } = await draftPost({ note: text, newsItem });
    const fullReply = draft + (newsUsed ? verifyBlock(newsItem) : "");

    const savedDraft = await saveDraft({ noteId: note?.id, chatId, draft: fullReply });
    // Persist the source whether or not it was used — a found-but-rejected source is
    // still worth keeping, it shows the triage worked.
    if (newsItem) {
      await saveSource({ draftId: savedDraft?.id, newsItem, used: newsUsed });
    }
    await sendMessage(
      chatId,
      `Score: ${score}/10 — ${reason}\n\n${fullReply}\n\n— Reply APPROVE or REJECT to log a decision on this draft.`
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    // Still 200 so Telegram doesn't retry-storm us; the error is in the logs.
    res.status(200).json({ ok: false, error: err.message });
  }
}
