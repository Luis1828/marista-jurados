-- Festival Intercolegial Marista - resultados públicos completos.
-- No elimina ni modifica datos existentes. Puede ejecutarse más de una vez.
-- Expone únicamente los datos de las bandas destinados a publicación:
-- nombre, notas, rutas de fotografías y puntuaciones agregadas por criterio.
-- Nunca expone cuentas, correos, IDs de usuarios, auditoría ni claves.

begin;

create or replace function public.get_public_festival_results()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with active_criteria as (
    select c.id, c.label, c.sort_order
    from public.scoring_criteria c
    where c.active = true
  ),
  criteria_stats as (
    select count(*)::integer as criteria_count
    from active_criteria
  ),
  band_totals as (
    select
      b.id,
      b.name,
      b.created_by,
      b.photo_path,
      b.notes,
      b.created_at,
      b.updated_at,
      (count(bs.criterion_id) filter (where ac.id is not null))::integer as scored_count,
      coalesce(sum(bs.score) filter (where ac.id is not null), 0)::integer as score_total,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'label', ac.label,
            'sort_order', ac.sort_order,
            'score', bs.score
          ) order by ac.sort_order
        ) filter (where ac.id is not null),
        '[]'::jsonb
      ) as criterion_scores
    from public.bands b
    left join public.band_scores bs on bs.band_id = b.id
    left join active_criteria ac on ac.id = bs.criterion_id
    where b.created_by is not null
    group by b.id, b.name, b.created_by, b.photo_path, b.notes, b.created_at, b.updated_at
  ),
  public_entries as (
    select
      bt.name,
      pg_catalog.md5(bt.created_by::text) as judge_key,
      bt.score_total,
      bt.criterion_scores,
      bt.photo_path,
      bt.notes,
      bt.updated_at
    from band_totals bt
    cross join criteria_stats cs
    where cs.criteria_count > 0
      and bt.scored_count = cs.criteria_count
  )
  select jsonb_build_object(
    'criteria_count', cs.criteria_count,
    'criteria', coalesce((
      select jsonb_agg(
        jsonb_build_object('label', ac.label, 'sort_order', ac.sort_order)
        order by ac.sort_order
      )
      from active_criteria ac
    ), '[]'::jsonb),
    'jurors_count', coalesce((
      select count(distinct pe.judge_key)::integer from public_entries pe
    ), 0),
    'incomplete_count', coalesce((
      select count(*)::integer
      from band_totals bt
      where cs.criteria_count = 0 or bt.scored_count <> cs.criteria_count
    ), 0),
    'entries', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', pe.name,
          'judge_key', pe.judge_key,
          'score_total', pe.score_total,
          'criterion_scores', pe.criterion_scores,
          'photo_path', pe.photo_path,
          'notes', pe.notes,
          'updated_at', pe.updated_at
        ) order by pe.name
      )
      from public_entries pe
    ), '[]'::jsonb),
    'generated_at', pg_catalog.now()
  )
  from criteria_stats cs;
$function$;

comment on function public.get_public_festival_results() is
  'Resultados públicos completos del Festival Marista: nombres, notas de las bandas, rutas de fotos y calificaciones consolidadas por criterio. No devuelve cuentas, usuarios, correos ni auditoría.';

-- Las tablas de aplicación siguen protegidas. La única lectura pública de datos
-- estructurados es la función anterior, que entrega una proyección limitada.
revoke all on table public.user_profiles, public.scoring_criteria, public.bands,
  public.band_scores, public.audit_logs from anon;
grant usage on schema public to anon;
revoke all on function public.get_public_festival_results() from public, anon, authenticated;
grant execute on function public.get_public_festival_results() to anon, authenticated;

notify pgrst, 'reload schema';

commit;
