-- GenAI Scout — initial schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- ─── Extensions ───────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";

-- ─── Domains ──────────────────────────────────────────────────────────────────
create table if not exists domains (
  id              uuid primary key default uuid_generate_v4(),
  host            text not null unique,
  name            text,
  cms_guess       text,                -- wordpress | ghost | substack | medium | custom
  dr_proxy_score  numeric(5,2) default 0,
  country         text,
  language        text,
  first_seen      timestamptz default now(),
  last_seen       timestamptz default now(),
  created_at      timestamptz default now()
);

-- ─── Authors ──────────────────────────────────────────────────────────────────
create table if not exists authors (
  id               uuid primary key default uuid_generate_v4(),
  full_name        text not null,
  slug             text,
  avatar_url       text,
  bio              text,
  role             text,
  primary_domain_id uuid references domains(id),
  same_as_json     jsonb default '[]',
  description      text,              -- AI/template-generated description
  source           text,              -- rss | gdelt | hn | reddit | wordpress | ghost | commoncrawl | wayback
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique (full_name, primary_domain_id)
);

-- ─── Articles ─────────────────────────────────────────────────────────────────
create table if not exists articles (
  id                    uuid primary key default uuid_generate_v4(),
  url_canonical         text not null unique,
  title                 text,
  excerpt               text,
  published_at          timestamptz,
  lastmod               timestamptz,
  lead_image_url        text,
  domain_id             uuid references domains(id),
  archetype             text,         -- listicle | review | comparison | explainer | news
  readability_text_excerpt text,
  raw_html_ref          text,
  source                text,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- ─── Article ↔ Author (many-to-many) ─────────────────────────────────────────
create table if not exists article_authors (
  article_id  uuid references articles(id) on delete cascade,
  author_id   uuid references authors(id) on delete cascade,
  primary key (article_id, author_id)
);

-- ─── Contacts ─────────────────────────────────────────────────────────────────
create table if not exists contacts (
  id              uuid primary key default uuid_generate_v4(),
  author_id       uuid references authors(id),
  domain_id       uuid references domains(id),
  type            text not null,      -- mailto | form | author_page | twitter | linkedin | mastodon
  value           text not null,
  confidence      numeric(3,2) default 0.5,  -- 0-1
  source          text,
  verified_syntax boolean default false,
  created_at      timestamptz default now(),
  unique (author_id, type, value)
);

-- ─── Tool Mentions ────────────────────────────────────────────────────────────
create table if not exists mentions (
  id          uuid primary key default uuid_generate_v4(),
  article_id  uuid references articles(id) on delete cascade,
  tool_name   text not null,
  count       integer default 1,
  unique (article_id, tool_name)
);

-- ─── Outbound Links ───────────────────────────────────────────────────────────
create table if not exists links (
  id          uuid primary key default uuid_generate_v4(),
  article_id  uuid references articles(id) on delete cascade,
  target_url  text not null,
  anchor_text text,
  unique (article_id, target_url)
);

-- ─── Discovery Hits (raw provenance) ─────────────────────────────────────────
create table if not exists discovery_hits (
  id            uuid primary key default uuid_generate_v4(),
  url           text not null,
  source        text not null,
  query         text,
  title         text,
  snippet       text,
  discovered_at timestamptz default now(),
  processed     boolean default false,
  unique (url, source)
);

-- ─── Scores ───────────────────────────────────────────────────────────────────
create table if not exists scores (
  id                  uuid primary key default uuid_generate_v4(),
  author_id           uuid references authors(id),
  article_id          uuid references articles(id),
  relevance           numeric(5,2) default 0,
  freshness           numeric(5,2) default 0,
  authority           numeric(5,2) default 0,
  competitor_overlap  numeric(5,2) default 0,
  contact_confidence  numeric(5,2) default 0,
  composite           numeric(5,2) default 0,
  computed_at         timestamptz default now(),
  unique (author_id, article_id)
);

-- ─── Suppression List ─────────────────────────────────────────────────────────
create table if not exists suppression (
  id          uuid primary key default uuid_generate_v4(),
  type        text not null,          -- domain | author | url
  value       text not null unique,
  reason      text,
  added_at    timestamptz default now()
);

-- ─── Seed Config ──────────────────────────────────────────────────────────────
create table if not exists seed_tools (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null unique,
  aliases     jsonb default '[]',
  enabled     boolean default true,
  created_at  timestamptz default now()
);

-- ─── Pipeline Runs ────────────────────────────────────────────────────────────
create table if not exists pipeline_runs (
  id          uuid primary key default uuid_generate_v4(),
  started_at  timestamptz default now(),
  finished_at timestamptz,
  stage       text,
  status      text default 'running',  -- running | completed | failed
  stats       jsonb default '{}',
  error       text
);

-- ─── Harvester Config ─────────────────────────────────────────────────────────
create table if not exists harvester_config (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null unique,
  enabled     boolean default true,
  config      jsonb default '{}'
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists idx_articles_domain on articles(domain_id);
create index if not exists idx_articles_published on articles(published_at desc);
create index if not exists idx_articles_archetype on articles(archetype);
create index if not exists idx_authors_domain on authors(primary_domain_id);
create index if not exists idx_mentions_tool on mentions(tool_name);
create index if not exists idx_scores_composite on scores(composite desc);
create index if not exists idx_scores_author on scores(author_id);
create index if not exists idx_discovery_processed on discovery_hits(processed);

-- ─── Seed default tools ───────────────────────────────────────────────────────
insert into seed_tools (name, aliases, enabled) values
  ('imagineart', '["imagine.art","ImagineArt"]', true),
  ('kling', '["Kling AI","Kuaishou"]', true),
  ('seedance', '["Seedance"]', true),
  ('runway', '["Runway ML","RunwayML"]', true),
  ('pika', '["Pika Labs","Pika Art"]', true),
  ('sora', '["OpenAI Sora"]', true),
  ('midjourney', '["MJ","Mid Journey"]', true),
  ('ideogram', '["Ideogram AI"]', true),
  ('luma', '["Luma AI","Dream Machine","LumaLabs"]', true),
  ('higgsfield', '["Higgsfield AI"]', true),
  ('hailuo', '["MiniMax Video","Hailuo AI"]', true),
  ('veo', '["Google Veo","Veo 2","Veo 3"]', true),
  ('flux', '["FLUX","Black Forest Labs","FLUX.1"]', true),
  ('heygen', '["HeyGen AI"]', true),
  ('nanobanana', '["Nano Banana"]', true),
  ('invideo', '["InVideo AI"]', true),
  ('krea', '["Krea AI"]', true),
  ('adobe firefly', '["Adobe Firefly","Firefly"]', true),
  ('canva ai', '["Canva Magic","Canva AI"]', true),
  ('leonardo', '["Leonardo AI","Leonardo.Ai"]', true)
on conflict (name) do nothing;

-- ─── Seed default harvesters ─────────────────────────────────────────────────
insert into harvester_config (name, enabled, config) values
  ('rss', true, '{"maxItemsPerFeed": 50}'),
  ('gdelt', true, '{"maxResults": 100}'),
  ('hackernews', true, '{"maxResults": 50}'),
  ('reddit', true, '{"subreddits": ["StableDiffusion","aivideo","artificial","midjourney","stablediffusion","AIAssistants","singularity","MediaSynthesis"]}'),
  ('wordpress', true, '{}'),
  ('ghost', true, '{}'),
  ('commoncrawl', true, '{"maxResults": 200}'),
  ('wayback', true, '{"maxResults": 100}'),
  ('brave', false, '{"maxResults": 50}')
on conflict (name) do nothing;
