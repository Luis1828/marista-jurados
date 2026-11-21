-- Festival Intercolegial Marista - esquema inicial
-- Ejecutar una sola vez en Supabase SQL Editor o con `supabase db push`.

create extension if not exists pgcrypto;

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  role text not null default 'juror' check (role in ('admin', 'juror')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-z0-9._-]{3,24}$')
);

create table if not exists public.scoring_criteria (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  sort_order integer not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scoring_criteria_label_not_empty check (length(trim(label)) between 1 and 50)
);

create table if not exists public.bands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  photo_path text not null,
  notes text not null default '',
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint band_name_not_empty check (length(trim(name)) between 1 and 90)
);

create table if not exists public.band_scores (
  band_id uuid not null references public.bands(id) on delete cascade,
  criterion_id uuid not null references public.scoring_criteria(id) on delete restrict,
  score integer not null check (score between 1 and 5),
  primary key (band_id, criterion_id)
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.user_profiles(id) on delete set null,
  actor_username text not null,
  actor_role text not null,
  action text not null,
  target_type text not null,
  target_id text,
  target_name text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bands_created_by_idx on public.bands(created_by);
create index if not exists bands_updated_at_idx on public.bands(updated_at desc);
create index if not exists band_scores_criterion_idx on public.band_scores(criterion_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);

-- No se crea perfil automáticamente al crear un usuario en Auth.
-- Las cuentas de jurados sólo reciben perfil desde la Edge Function administrativa.
-- El primer administrador se provisiona manualmente mediante SQL (ver README.md).

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.id = auth.uid() and p.is_active = true
  );
$$;

create or replace function public.is_juror()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.id = auth.uid() and p.is_active = true and p.role = 'juror'
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_profiles p
    where p.id = auth.uid() and p.is_active = true and p.role = 'admin'
  );
$$;

-- Auditoría automática de los cambios a los patrones de evaluación.
create or replace function public.audit_criteria_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.user_profiles%rowtype;
  v_action text;
  v_old jsonb;
  v_new jsonb;
begin
  select * into v_actor from public.user_profiles where id = auth.uid();
  if not found then
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_action := 'criteria_created';
    v_new := to_jsonb(new);
  else
    v_action := 'criteria_updated';
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
  end if;
  insert into public.audit_logs(actor_id, actor_username, actor_role, action, target_type, target_id, target_name, details)
  values (v_actor.id, v_actor.username, v_actor.role, v_action, 'criterion', coalesce(new.id, old.id)::text,
          coalesce(new.label, old.label), jsonb_build_object('before', v_old, 'after', v_new));
  return new;
end;
$$;

drop trigger if exists scoring_criteria_audit_trigger on public.scoring_criteria;
create trigger scoring_criteria_audit_trigger
after insert or update on public.scoring_criteria
for each row execute procedure public.audit_criteria_change();

-- Guardar una banda y todas sus puntuaciones en una sola transacción.
-- No existe política RLS de INSERT/UPDATE para bandas ni puntuaciones: el navegador
-- únicamente puede escribir mediante esta función, que valida el rol jurado.
create or replace function public.save_band(
  p_id uuid,
  p_name text,
  p_photo_path text,
  p_notes text,
  p_scores jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_actor public.user_profiles%rowtype;
  v_pair record;
  v_criterion_id uuid;
  v_score integer;
  v_old jsonb := null;
  v_new jsonb;
  v_action text;
  v_active_count integer;
  v_saved_count integer := 0;
begin
  if not public.is_juror() then
    raise exception 'No tienes permiso para crear o editar bandas.' using errcode = '42501';
  end if;

  if nullif(trim(p_name), '') is null or length(trim(p_name)) > 90 then
    raise exception 'El nombre de la banda debe tener entre 1 y 90 caracteres.' using errcode = '22023';
  end if;
  if nullif(trim(p_photo_path), '') is null then
    raise exception 'La fotografía de la banda es obligatoria.' using errcode = '22023';
  end if;
  if length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Los comentarios no pueden superar los 2000 caracteres.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_scores) is distinct from 'object' then
    raise exception 'Las puntuaciones tienen un formato inválido.' using errcode = '22023';
  end if;

  select * into v_actor from public.user_profiles where id = auth.uid() and is_active = true;
  select count(*) into v_active_count from public.scoring_criteria where active = true;
  if v_active_count < 3 then
    raise exception 'Debe haber al menos tres criterios de evaluación activos.' using errcode = '22023';
  end if;
  if jsonb_object_length(p_scores) <> v_active_count then
    raise exception 'Debes calificar todos los criterios activos.' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.bands(name, photo_path, notes, created_by)
    values (trim(p_name), p_photo_path, coalesce(p_notes, ''), auth.uid())
    returning id into v_id;
    v_action := 'created';
  else
    select jsonb_build_object(
      'id', b.id,
      'name', b.name,
      'photo_path', b.photo_path,
      'notes', b.notes,
      'scores', coalesce((select jsonb_object_agg(bs.criterion_id::text, bs.score)
                          from public.band_scores bs where bs.band_id = b.id), '{}'::jsonb)
    ) into v_old
    from public.bands b where b.id = p_id;
    if v_old is null then
      raise exception 'La banda indicada no existe.' using errcode = 'P0002';
    end if;
    update public.bands
       set name = trim(p_name), photo_path = p_photo_path, notes = coalesce(p_notes, ''), updated_at = now()
     where id = p_id
     returning id into v_id;
    v_action := 'edited';
  end if;

  for v_pair in select key, value from jsonb_each(p_scores) loop
    begin
      v_criterion_id := v_pair.key::uuid;
      v_score := (v_pair.value #>> '{}')::integer;
    exception when others then
      raise exception 'Una puntuación contiene un identificador o valor inválido.' using errcode = '22023';
    end;
    if v_score is null or v_score < 1 or v_score > 5 then
      raise exception 'Cada puntuación debe estar entre 1 y 5.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.scoring_criteria c where c.id = v_criterion_id and c.active = true) then
      raise exception 'Se intentó guardar un criterio que no está activo.' using errcode = '22023';
    end if;
    insert into public.band_scores(band_id, criterion_id, score)
    values (v_id, v_criterion_id, v_score)
    on conflict (band_id, criterion_id) do update set score = excluded.score;
    v_saved_count := v_saved_count + 1;
  end loop;

  if v_saved_count <> v_active_count then
    raise exception 'La cantidad de puntuaciones no coincide con los criterios activos.' using errcode = '22023';
  end if;

  delete from public.band_scores bs
   where bs.band_id = v_id
     and not exists (select 1 from public.scoring_criteria c where c.id = bs.criterion_id and c.active = true);

  select jsonb_build_object(
    'id', b.id,
    'name', b.name,
    'photo_path', b.photo_path,
    'notes', b.notes,
    'scores', coalesce((select jsonb_object_agg(bs.criterion_id::text, bs.score)
                        from public.band_scores bs where bs.band_id = b.id), '{}'::jsonb)
  ) into v_new
  from public.bands b where b.id = v_id;

  insert into public.audit_logs(actor_id, actor_username, actor_role, action, target_type, target_id, target_name, details)
  values (v_actor.id, v_actor.username, v_actor.role, v_action, 'band', v_id::text, trim(p_name),
          jsonb_build_object('before', v_old, 'after', v_new));

  return v_id;
end;
$$;

revoke all on function public.save_band(uuid, text, text, text, jsonb) from public;
grant execute on function public.save_band(uuid, text, text, text, jsonb) to authenticated;

-- Eliminación auditada y atómica. Sólo la Edge Function, tras revalidar contraseña,
-- puede invocarla con la clave privada de servidor.
create or replace function public.delete_band_audited(
  p_band_id uuid,
  p_actor_id uuid,
  p_actor_username text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_band public.bands%rowtype;
  v_scores jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Operación reservada al servidor.' using errcode = '42501';
  end if;
  select * into v_band from public.bands where id = p_band_id for update;
  if not found then
    raise exception 'La banda ya no existe.' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_object_agg(bs.criterion_id::text, bs.score), '{}'::jsonb)
    into v_scores from public.band_scores bs where bs.band_id = p_band_id;

  insert into public.audit_logs(actor_id, actor_username, actor_role, action, target_type, target_id, target_name, details)
  values (p_actor_id, p_actor_username, 'juror', 'deleted', 'band', v_band.id::text, v_band.name,
          jsonb_build_object('before', jsonb_build_object(
            'id', v_band.id, 'name', v_band.name, 'photo_path', v_band.photo_path,
            'notes', v_band.notes, 'created_by', v_band.created_by,
            'created_at', v_band.created_at, 'updated_at', v_band.updated_at,
            'scores', v_scores
          ), 'deleted_after_password_recheck', true));

  delete from public.bands where id = p_band_id;
  return jsonb_build_object('name', v_band.name, 'photo_path', v_band.photo_path);
end;
$$;

revoke all on function public.delete_band_audited(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.delete_band_audited(uuid, uuid, text) to service_role;

-- Privacidad y control de acceso.
alter table public.user_profiles enable row level security;
alter table public.scoring_criteria enable row level security;
alter table public.bands enable row level security;
alter table public.band_scores enable row level security;
alter table public.audit_logs enable row level security;

-- Permisos explícitos para Data API: no es necesario habilitar la exposición
-- automática de futuras tablas. RLS decide qué filas/operaciones puede realizar
-- cada usuario; estos GRANT sólo habilitan las operaciones requeridas por la app.
revoke all on table public.user_profiles, public.scoring_criteria, public.bands,
  public.band_scores, public.audit_logs from anon, authenticated;
grant usage on schema public to authenticated;
grant select on table public.user_profiles, public.scoring_criteria, public.bands,
  public.band_scores, public.audit_logs to authenticated;
-- Los administradores actualizan criterios; RLS limita estas operaciones a admin.
grant insert, update on table public.scoring_criteria to authenticated;

-- Las funciones auxiliares de las políticas sólo se ejecutan con sesión autenticada.
revoke all on function public.is_active_user() from public, anon;
revoke all on function public.is_juror() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_active_user() to authenticated;
grant execute on function public.is_juror() to authenticated;
grant execute on function public.is_admin() to authenticated;

drop policy if exists profiles_select_self_or_admin on public.user_profiles;
create policy profiles_select_self_or_admin on public.user_profiles
for select to authenticated
using (id = auth.uid() or public.is_admin());

-- Todos los usuarios activos pueden leer criterios; sólo admin puede crear/editar.
drop policy if exists criteria_select_active_users on public.scoring_criteria;
create policy criteria_select_active_users on public.scoring_criteria
for select to authenticated using (public.is_active_user());
drop policy if exists criteria_insert_admin on public.scoring_criteria;
create policy criteria_insert_admin on public.scoring_criteria
for insert to authenticated with check (public.is_admin());
drop policy if exists criteria_update_admin on public.scoring_criteria;
create policy criteria_update_admin on public.scoring_criteria
for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Bandas y puntuaciones: lectura para usuarios activos. Escritura únicamente vía save_band().
drop policy if exists bands_select_active_users on public.bands;
create policy bands_select_active_users on public.bands
for select to authenticated using (public.is_active_user());
drop policy if exists scores_select_active_users on public.band_scores;
create policy scores_select_active_users on public.band_scores
for select to authenticated using (public.is_active_user());

-- Logs inmutables desde el navegador; la escritura se hace desde funciones SQL/Edge confiables.
drop policy if exists audit_select_active_users on public.audit_logs;
create policy audit_select_active_users on public.audit_logs
for select to authenticated using (public.is_active_user());

-- Fotos privadas: sólo usuarios activos pueden leerlas; sólo jurados pueden subir, cambiar o borrar.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('band-photos', 'band-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

drop policy if exists band_photos_read_active on storage.objects;
create policy band_photos_read_active on storage.objects
for select to authenticated
using (bucket_id = 'band-photos' and public.is_active_user());
drop policy if exists band_photos_insert_juror on storage.objects;
create policy band_photos_insert_juror on storage.objects
for insert to authenticated
with check (bucket_id = 'band-photos' and public.is_juror() and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists band_photos_update_juror on storage.objects;
create policy band_photos_update_juror on storage.objects
for update to authenticated
using (bucket_id = 'band-photos' and public.is_juror() and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'band-photos' and public.is_juror() and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists band_photos_delete_juror on storage.objects;
create policy band_photos_delete_juror on storage.objects
for delete to authenticated
using (bucket_id = 'band-photos' and public.is_juror() and (storage.foldername(name))[1] = auth.uid()::text);

-- Seis ejes temporales para que el radar inicial sea un hexágono PES.
insert into public.scoring_criteria(label, sort_order, active)
select v.label, v.sort_order, true
from (values ('1', 1), ('2', 2), ('3', 3), ('4', 4), ('5', 5), ('6', 6)) as v(label, sort_order)
where not exists (select 1 from public.scoring_criteria);

-- Importante: no se crean políticas de DELETE para bandas ni de escritura directa para band_scores.
