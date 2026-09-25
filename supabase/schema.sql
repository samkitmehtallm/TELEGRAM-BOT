-- Deployed live to Supabase project skinstinct-content-engine (lzuufsiiuiqbpqvdyldl, ap-south-1).
-- This file is the source of truth for anyone re-creating the schema elsewhere.

create table if not exists voice_skill (
  id bigint generated always as identity primary key,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists notes (
  id bigint generated always as identity primary key,
  chat_id text not null,
  text text not null,
  score numeric,
  reason text,
  status text not null default 'queued', -- queued | rejected | drafted
  criteria jsonb,                        -- {specificity, mechanism, territory_alignment, brand_grounding, reader_value}
  created_at timestamptz not null default now()
);

create table if not exists drafts (
  id bigint generated always as identity primary key,
  note_id bigint references notes (id),
  chat_id text not null,
  draft_text text not null,
  status text not null default 'pending', -- pending | approved | rejected
  checks jsonb,                            -- list of failed style checks, e.g. word count / hashtags / spelling
  created_at timestamptz not null default now()
);

-- One row per news source surfaced for a draft (not just the one used) — kept even
-- when a source was found but correctly not cited, so the triage is auditable.
create table if not exists sources (
  id bigint generated always as identity primary key,
  draft_id bigint references drafts (id) on delete cascade,
  headline text not null,
  publication text,
  published_date text,
  url text,
  summary text,
  used_in_draft boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notes_chat_id on notes (chat_id);
create index if not exists idx_notes_status_chat on notes (chat_id, status);
create index if not exists idx_drafts_chat_id_status on drafts (chat_id, status);
create index if not exists idx_sources_draft_id on sources (draft_id);

-- RLS is currently OFF on all four tables (fine as long as the key stays server-side only).
-- To lock it down later:
-- alter table voice_skill enable row level security;
-- alter table notes enable row level security;
-- alter table drafts enable row level security;
-- alter table sources enable row level security;
-- ...then add policies for the service role / anon key this bot uses.
