-- Festival Intercolegial Marista - empates y desempate manual por jurado.
-- Ejecutar UNA SOLA VEZ en Supabase SQL Editor, sobre la base ya existente.
-- No altera ni elimina bandas, puntuaciones, usuarios o auditoría.

begin;

alter table public.bands
  add column if not exists tie_break_order integer;

comment on column public.bands.tie_break_order is
  'Orden manual dentro de un grupo con promedio exactamente empatado. NULL significa que el jurado aún no resolvió el desempate.';

-- Sólo el jurado propietario puede resolver un empate; el administrador
-- conserva lectura de las evaluaciones, pero no puede decidir sus posiciones.
create or replace function public.save_tie_break_order(p_band_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.user_profiles%rowtype;
  v_requested_count integer;
  v_unique_count integer;
  v_selected_count integer;
  v_min_total bigint;
  v_max_total bigint;
  v_active_criteria integer;
  v_average numeric;
  v_ordered_bands jsonb;
begin
  if not public.is_juror() then
    raise exception 'Sólo el jurado propietario puede resolver sus empates.'
      using errcode = '42501';
  end if;

  v_requested_count := coalesce(array_length(p_band_ids, 1), 0);
  if v_requested_count < 2 then
    raise exception 'Un desempate requiere al menos dos bandas.'
      using errcode = '22023';
  end if;

  select count(distinct u.id)::integer
    into v_unique_count
  from unnest(p_band_ids) as u(id);

  if v_unique_count <> v_requested_count then
    raise exception 'La lista de bandas contiene identificadores repetidos o inválidos.'
      using errcode = '22023';
  end if;

  select count(*)::integer
    into v_selected_count
  from public.bands b
  where b.id = any(p_band_ids)
    and b.created_by = auth.uid();

  if v_selected_count <> v_requested_count then
    raise exception 'Sólo puedes resolver empates entre bandas registradas por tu propia cuenta.'
      using errcode = '42501';
  end if;

  select count(*)::integer
    into v_active_criteria
  from public.scoring_criteria c
  where c.active = true;

  if v_active_criteria < 1 then
    raise exception 'No existen criterios activos para calcular el promedio.'
      using errcode = '22023';
  end if;

  -- La igualdad se valida con la suma entera de los criterios activos.
  -- Como todos comparten el mismo denominador, esto equivale al mismo promedio
  -- exacto y evita falsos empates por redondear a dos decimales.
  select count(*)::integer, min(x.score_total), max(x.score_total)
    into v_selected_count, v_min_total, v_max_total
  from (
    select b.id,
           coalesce(sum(bs.score) filter (where c.active = true), 0)::bigint as score_total
    from public.bands b
    left join public.band_scores bs on bs.band_id = b.id
    left join public.scoring_criteria c on c.id = bs.criterion_id
    where b.id = any(p_band_ids)
      and b.created_by = auth.uid()
    group by b.id
  ) as x;

  if v_selected_count <> v_requested_count or v_min_total is null or v_min_total <> v_max_total then
    raise exception 'Las bandas seleccionadas no tienen exactamente el mismo promedio.'
      using errcode = '22023';
  end if;

  -- Exigir que la petición contenga a todas las bandas de ese jurado con
  -- ese mismo promedio. No se permite resolver sólo una parte del empate.
  if exists (
    select 1
    from public.bands b
    where b.created_by = auth.uid()
      and not (b.id = any(p_band_ids))
      and (
        select coalesce(sum(bs.score), 0)::bigint
        from public.band_scores bs
        join public.scoring_criteria c on c.id = bs.criterion_id and c.active = true
        where bs.band_id = b.id
      ) = v_min_total
  ) then
    raise exception 'El grupo de empate cambió. Actualiza la página y vuelve a resolverlo.'
      using errcode = '22023';
  end if;

  update public.bands b
     set tie_break_order = requested.ordinality::integer
    from unnest(p_band_ids) with ordinality as requested(id, ordinality)
   where b.id = requested.id
     and b.created_by = auth.uid();

  select * into v_actor
  from public.user_profiles p
  where p.id = auth.uid()
    and p.is_active = true
    and p.role = 'juror';

  select jsonb_agg(
           jsonb_build_object(
             'id', b.id,
             'name', b.name,
             'position', requested.ordinality
           ) order by requested.ordinality
         )
    into v_ordered_bands
  from unnest(p_band_ids) with ordinality as requested(id, ordinality)
  join public.bands b on b.id = requested.id;

  v_average := round(v_min_total::numeric / v_active_criteria, 2);

  insert into public.audit_logs(
    actor_id, actor_username, actor_role, action, target_type,
    target_id, target_name, details
  )
  values (
    v_actor.id,
    v_actor.username,
    'juror',
    'tie_break',
    'tie_group',
    v_min_total::text,
    'Empate con promedio ' || to_char(v_average, 'FM990.00'),
    jsonb_build_object(
      'score_total', v_min_total,
      'active_criteria', v_active_criteria,
      'average', v_average,
      'ordered_bands', v_ordered_bands
    )
  );

  return jsonb_build_object(
    'average', v_average,
    'ordered_bands', v_ordered_bands,
    'tie_preserved', true
  );
end;
$$;

revoke all on function public.save_tie_break_order(uuid[]) from public, anon;
grant execute on function public.save_tie_break_order(uuid[]) to authenticated;

-- Cualquier cambio que pueda alterar la composición de un empate invalida
-- los órdenes manuales anteriores del jurado correspondiente.
create or replace function public.reset_tie_breaks_after_band_score_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_band_id uuid;
  v_owner_id uuid;
begin
  if tg_op = 'DELETE' then
    v_band_id := old.band_id;
  else
    v_band_id := new.band_id;
  end if;

  select b.created_by into v_owner_id
  from public.bands b
  where b.id = v_band_id;

  if v_owner_id is not null then
    update public.bands
       set tie_break_order = null
     where created_by = v_owner_id
       and tie_break_order is not null;
  end if;

  return null;
end;
$$;

create or replace function public.reset_tie_breaks_after_band_membership_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
begin
  if tg_op = 'DELETE' then
    v_owner_id := old.created_by;
  else
    v_owner_id := new.created_by;
  end if;

  if v_owner_id is not null then
    update public.bands
       set tie_break_order = null
     where created_by = v_owner_id
       and tie_break_order is not null;
  end if;

  return null;
end;
$$;

create or replace function public.reset_tie_breaks_after_criteria_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bands
     set tie_break_order = null
   where tie_break_order is not null;
  return null;
end;
$$;

drop trigger if exists band_scores_reset_ties_insert_delete on public.band_scores;
create trigger band_scores_reset_ties_insert_delete
after insert or delete on public.band_scores
for each row execute function public.reset_tie_breaks_after_band_score_change();

drop trigger if exists band_scores_reset_ties_update on public.band_scores;
create trigger band_scores_reset_ties_update
after update of score on public.band_scores
for each row
when (old.score is distinct from new.score)
execute function public.reset_tie_breaks_after_band_score_change();

drop trigger if exists bands_reset_ties_membership on public.bands;
create trigger bands_reset_ties_membership
after insert or delete on public.bands
for each row execute function public.reset_tie_breaks_after_band_membership_change();

drop trigger if exists scoring_criteria_reset_ties_insert_delete on public.scoring_criteria;
create trigger scoring_criteria_reset_ties_insert_delete
after insert or delete on public.scoring_criteria
for each row execute function public.reset_tie_breaks_after_criteria_change();

drop trigger if exists scoring_criteria_reset_ties_active_update on public.scoring_criteria;
create trigger scoring_criteria_reset_ties_active_update
after update of active on public.scoring_criteria
for each row
when (old.active is distinct from new.active)
execute function public.reset_tie_breaks_after_criteria_change();

notify pgrst, 'reload schema';

commit;
