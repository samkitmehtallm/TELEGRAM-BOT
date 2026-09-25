# Skinstinct Content Bot

A Telegram bot for Meera (Skinstinct). She drops a raw note into the chat — that
note is the trigger. If it scores well enough, the bot immediately finds a news
angle (only if one genuinely fits), drafts a LinkedIn post in her voice, and runs
every style rule before showing it to her. No separate command, no cap on how
many per week. **The bot never publishes anything — Meera is always the final
reviewer.**

## How it works

Send any note — raw, half-formed, a musing you haven't worked out yet. **Every note
produces a post.** The pipeline:

1. **Scrape sources** — three search queries are generated from the note (the topic
   itself, the wider industry/regulatory angle, the India-market angle) and each is
   run against Google News, collecting several candidates.
2. **Draft** — the post is written in Meera's voice, citing whichever sources
   genuinely strengthen it. If the note is an unresolved musing, the drafter picks
   the sharpest publishable angle inside it and commits to it.
3. **Style checks** — word count 350–600, no hashtags, no exclamation marks, no
   wellness-marketing jargon, British/Indian spelling. Failures are listed under
   the draft. A banned phrase Meera used in her own note isn't flagged — she's
   discussing the term deliberately.
4. **Score the draft** — 0–10 on three founder criteria:
   - **source validation** — are the claims verifiable, backed by her documented
     practice or a cited source?
   - **context** — is it situated in the real current landscape (Indian market,
     regulation, category dynamics)?
   - **brand recall** — would a reader come away remembering Meera and Skinstinct
     specifically, not generic industry commentary?

   The score grades the output. **It never blocks it.**
5. Every source found is listed under the post — cited or not — with a verify
   warning, because she publishes under her own name.

Commands: `/revise <feedback>` redrafts the last post · `/score <text>` scores any
text you wrote yourself · `/status` recent activity · `APPROVE`/`REJECT` logs a
decision on the latest draft.

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
