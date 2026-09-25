# Skinstinct Content Engine — MESA Case 1

Telegram note → publishability score → news angle → LinkedIn draft in Meera's voice
→ back to Telegram for her approval. Nothing publishes itself (Check 07, the Cut).

## What's here

```
api/webhook.js     Telegram webhook handler — the whole pipeline
lib/telegram.js    sendMessage() to Telegram
lib/ai.js          scoreNote(), extractKeywords(), draftPost() — Gemini + Claude
lib/news.js        Google News RSS lookup, no key needed
lib/db.js          Optional Supabase memory layer (no-ops if unconfigured)
supabase/schema.sql  notes / drafts tables for the memory layer
voice-skill.txt    Meera's voice profile, fed to the drafting model every run
.env.example       All the keys you need, unset
```

## 1. Fill in your keys

Copy `.env.example` to `.env` (already done locally if you're reading this from the
build) and fill in:

- `TELEGRAM_BOT_TOKEN` — from BotFather
- `GEMINI_API_KEY` — Google AI Studio (used for scoring + keyword extraction, and
  for drafting if `DRAFT_PROVIDER=gemini`)
- `ANTHROPIC_API_KEY` — used for drafting when `DRAFT_PROVIDER=claude` (default,
  matches B1: Claude holds voice better across a full post)
- `SUPABASE_URL` / `SUPABASE_KEY` — optional, only needed for the B1·3 memory layer

`.env` is gitignored. Never commit it.

## 2. Push to GitHub

```bash
cd skinstinct-content-engine
git init
git add -A
git commit -m "Skinstinct content engine — Case 1"
gh repo create skinstinct-content-engine --private --source=. --push
```

(No `gh`? Create an empty repo on github.com, then `git remote add origin <url>` and
`git push -u origin main`.)

## 3. Deploy on Vercel

1. vercel.com → Add New → Project → import the GitHub repo
2. Before deploying, open **Environment Variables** and add every key from your
   `.env` file — exactly as they appear there
3. Deploy. Copy the resulting URL (`https://your-project.vercel.app`)

## 4. Point Telegram at your deployment

In a browser, visit (fill in your own token and URL):

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_VERCEL_URL>/api/webhook
```

You should see `"ok":true`. If not: check for stray spaces in the token, and make
sure the Vercel URL is from a completed deployment, not a preview.

## 5. Memory layer (optional, B1·3)

Run `supabase/schema.sql` in your Supabase project's SQL editor, then add
`SUPABASE_URL` / `SUPABASE_KEY` to Vercel's env vars and redeploy. Without these set,
the pipeline runs exactly the same — it just doesn't persist notes/drafts.

## 6. Test

Send a real note (from `notes/`, or your own) to the bot on Telegram.

- **Strong note** (a clear point, an observation, a number) → score 6+ → a draft
  comes back with a verify block if a news item was used
- **Weak note** (a reminder, a stray half-thought) → score below threshold → a short
  rejection message, no draft

Reply `APPROVE` or `REJECT` to log a decision on the most recent draft in that chat.

## Model split (why two providers)

| Task | Model | Why |
|---|---|---|
| Scoring notes | Gemini Flash | fast, cheap, no real judgment needed |
| Keyword extraction | Gemini Flash | fast, cheap, mechanical |
| Drafting the post | Claude (`DRAFT_PROVIDER=claude`) | holds voice consistently across a full post |
| Drafting (L3 fallback) | Gemini (`DRAFT_PROVIDER=gemini`) | for parity with the L3 demo if Claude key isn't set yet |

Swap `DRAFT_PROVIDER` in `.env` / Vercel env vars to compare the two on the same note.

## The boundary this respects

Check 07 (Judgment Protected) failed on purpose — Meera passed on two consultants who
offered end-to-end automation. This pipeline drafts; it never posts. Every draft that
used a news item carries an explicit `⚠ Check this before publishing` block, because a
fact published under her name that she hasn't verified is the exact failure this
exists to prevent.
