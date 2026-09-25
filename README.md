# Skinstinct Content Bot

A Telegram bot for Meera (Skinstinct). She drops raw notes into the chat; the bot
scores them, queues the ones worth developing, and on `/draft` writes a LinkedIn
post in her voice — with a news angle when one genuinely fits, and every style
rule checked before it's shown to her. **The bot never publishes anything — Meera
is always the final reviewer.**

## How it works

1. Send any plain-text note → scored 0–10 across five criteria (specificity,
   mechanism, territory alignment, brand grounding, reader value). Score ≥
   `QUEUE_THRESHOLD` (default 7) queues it; otherwise it's rejected with a reason.
2. `/draft` — pulls the oldest queued note, looks for a relevant news angle
   (ignored if it doesn't genuinely fit), drafts in Meera's voice, and runs it
   through style checks (word count 350–600, no hashtags, no exclamation marks,
   no wellness-marketing jargon, British/Indian spelling). Failed checks are
   listed under the draft. Capped at `WEEKLY_CAP` drafts (default 3) per
   calendar week.
3. `/revise <feedback>` — redrafts the last post with that feedback applied.
4. `/queue` — lists what's queued and waiting.
5. `/score [text]` — dry-run a score without queuing, or check what's next up.
6. `/status` — queue size, drafts used this week, current threshold/model.
7. Reply `APPROVE` / `REJECT` to log a decision on the latest draft.

## Files

```
bot.js                  Everything — long-polling loop, scoring, drafting, checks, persistence
meera_voice_guide.txt   Meera's voice profile, fed to the drafting model every run
supabase/schema.sql     notes / drafts / sources tables
.env.example            All the keys/config you need, unset
```

## Setup

```bash
npm install
cp .env.example .env   # fill in your keys
npm start               # runs bot.js — a long-lived process, not a serverless function
```

Required: `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`. Optional: `ANTHROPIC_API_KEY`
(only if `DRAFT_PROVIDER=claude`), `SUPABASE_URL` + `SUPABASE_KEY` (memory layer —
without these the bot still works, it just doesn't persist anything).

## Why long-polling, not a webhook

This bot polls Telegram directly (`getUpdates` in a loop) instead of registering
a webhook, so it needs a process that stays running — your machine, a small VPS,
or a host like Railway/Render. It will **not** run on Vercel or any serverless
platform, since those don't keep a process alive between requests. If you'd
rather run this as a webhook on Vercel instead, the loop in `bot.js` (`main()` /
`getUpdates`) is the only part that would need to change — the scoring, drafting,
and persistence logic underneath is otherwise the same either way.

## Memory layer

Run `supabase/schema.sql` in your Supabase project's SQL editor, then set
`SUPABASE_URL` / `SUPABASE_KEY`. Tables:

- `notes` — every note scored, with its 5-criteria breakdown and `status`
  (`queued` / `rejected` / `drafted`)
- `drafts` — generated posts, with `status` (`pending` / `approved` / `rejected`)
  and the style-check results
- `sources` — every news item surfaced per draft, with `used_in_draft` flagging
  whether it was actually cited or correctly set aside

## The boundary this respects

Nothing here posts to LinkedIn. The riskiest thing this bot can do is hand Meera
a bad draft she rejects — not publish something under her name she hasn't seen.
Any draft that cites a news source carries an explicit verify block, because a
fact published in her name that she hasn't checked is the exact failure this
exists to prevent.
