-- Run this once in your Supabase SQL editor to create the leads table

create table if not exists public.leads (
  id uuid default gen_random_uuid() primary key,
  business_name text not null,
  niche text not null,
  location text not null,
  email text,
  phone text,
  website text,
  google_maps_url text,
  google_rating numeric(3,1),
  review_count integer,
  instagram text,
  facebook text,
  score integer not null default 0,
  score_reasons text[] not null default '{}',
  gap_analysis text not null default '',
  pitch_angle text not null default '',
  status text not null default 'found'
    check (status in ('found', 'approved', 'rejected', 'emailed', 'responded', 'converted')),
  discord_message_id text,
  created_at timestamptz default now()
);

-- Index for fast lookups by Discord message
create index if not exists leads_discord_message_id_idx on public.leads(discord_message_id);

-- Index for filtering by status
create index if not exists leads_status_idx on public.leads(status);

-- Enable RLS
alter table public.leads enable row level security;

-- Service role has full access (used by ardeno-engine worker)
create policy "Service role full access" on public.leads
  for all using (auth.role() = 'service_role');
