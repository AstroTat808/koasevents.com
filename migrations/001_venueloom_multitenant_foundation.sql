-- VenueLoom target multi-tenant schema.
-- Netlify Blob remains the compatibility persistence layer during P0.
-- Apply this migration only after the Postgres environment is connected and Koa validation snapshots pass.

create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  legacy_tenant_id text unique,
  slug text not null unique,
  legal_name text not null,
  display_name text not null,
  status text not null check (status in ('trial','active','past_due','suspended','canceled')),
  locale text not null,
  currency text not null,
  timezone text not null,
  default_country text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  identity_provider_subject text unique,
  email citext not null unique,
  name text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role_id text not null,
  status text not null check (status in ('invited','active','disabled')),
  invited_by uuid references users(id),
  invited_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,user_id)
);

create table if not exists tenant_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  record_type text not null,
  legacy_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,record_type,legacy_id)
);

create table if not exists tenant_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  record_type text not null,
  record_id text not null,
  storage_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists integration_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  provider text not null,
  environment text not null default 'production',
  encrypted_credential_ref text,
  remote_account_id text,
  remote_account_name text,
  status text not null default 'disconnected',
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  last_verified_at timestamptz,
  unique (tenant_id,provider,environment)
);

create table if not exists integration_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references organizations(id) on delete cascade,
  provider text not null,
  local_entity_type text not null,
  local_entity_id text not null,
  remote_entity_type text not null,
  remote_entity_id text not null,
  remote_name text,
  metadata jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  unique (tenant_id,provider,local_entity_type,local_entity_id,remote_entity_type)
);

alter table memberships enable row level security;
alter table tenant_records enable row level security;
alter table tenant_documents enable row level security;
alter table integration_connections enable row level security;
alter table integration_mappings enable row level security;

create or replace function current_tenant_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.tenant_id',true),'')::uuid $$;

drop policy if exists memberships_tenant_isolation on memberships;
create policy memberships_tenant_isolation on memberships
  using (tenant_id=current_tenant_id()) with check (tenant_id=current_tenant_id());

drop policy if exists tenant_records_isolation on tenant_records;
create policy tenant_records_isolation on tenant_records
  using (tenant_id=current_tenant_id()) with check (tenant_id=current_tenant_id());

drop policy if exists tenant_documents_isolation on tenant_documents;
create policy tenant_documents_isolation on tenant_documents
  using (tenant_id=current_tenant_id()) with check (tenant_id=current_tenant_id());

drop policy if exists integration_connections_isolation on integration_connections;
create policy integration_connections_isolation on integration_connections
  using (tenant_id=current_tenant_id()) with check (tenant_id=current_tenant_id());

drop policy if exists integration_mappings_isolation on integration_mappings;
create policy integration_mappings_isolation on integration_mappings
  using (tenant_id=current_tenant_id()) with check (tenant_id=current_tenant_id());
