-- ============================================================
-- Sistema de admisión CAP — esquema completo
-- Ejecutar en el SQL Editor de Supabase (una sola vez).
-- Después ejecutar supabase/auth_hook.sql y activar el hook
-- en Dashboard > Authentication > Hooks.
-- ============================================================

-- ---------- Extensiones ----------
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

-- unaccent() es STABLE; para usarla en columnas generadas e índices
-- necesitamos un wrapper IMMUTABLE (el diccionario no cambia).
create or replace function public.f_unaccent(t text)
returns text language sql immutable parallel safe
set search_path = ''
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, t) $$;

-- ---------- Helper de rol (RBAC) ----------
-- Lee el rol desde el claim del JWT (inyectado por el custom access
-- token hook). Fallback SECURITY DEFINER a perfiles si el claim no
-- está (p. ej. token emitido antes de activar el hook).
create or replace function public.rol()
returns text language plpgsql stable security definer
set search_path = ''
as $$
declare r text;
begin
  r := coalesce(
    auth.jwt() ->> 'user_rol',
    (select rol from public.perfiles where id = auth.uid())
  );
  return r;
end $$;

-- ---------- Helper de MFA (aal2) ----------
-- Exige aal2 en el servidor, pero solo para usuarios que ya inscribieron
-- un factor verificado (así no se rompe a quien no configuró TOTP).
-- Devuelve true si el token es aal2, o si el usuario no tiene factor
-- verificado en auth.mfa_factors.
create or replace function public.mfa_ok()
returns boolean language sql stable security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors
        where user_id = auth.uid() and status = 'verified'
      )
$$;

-- ============================================================
-- TABLAS
-- ============================================================

-- ---------- perfiles ----------
create table public.perfiles (
  id     uuid primary key references auth.users(id) on delete cascade,
  nombre text not null default '',
  rol    text not null default 'digitador'
         check (rol in ('digitador','estadistica','admin')),
  creado timestamptz not null default now()
);

-- Trigger: crea el perfil al registrarse un usuario (rol por defecto digitador)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.perfiles (id, nombre)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email,'@',1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- pacientes ----------
-- Correlativo: ID permanente del paciente. Secuencia de Postgres =
-- asignación atómica sin bloqueos. Puede tener huecos por rollback;
-- aceptable para un ID de paciente.
create sequence public.seq_correlativo start 1;

create table public.pacientes (
  id          uuid primary key default gen_random_uuid(),
  correlativo bigint not null unique default nextval('public.seq_correlativo'),
  nombres     text not null check (length(trim(nombres)) between 1 and 120),
  apellidos   text not null check (length(trim(apellidos)) between 1 and 120),
  -- DPI/CUI: opcional y NO único (a veces no lo traen; puede repetirse)
  documento   text check (documento is null or length(documento) <= 20),
  created_at  timestamptz not null default now(),
  -- Búsqueda full-text sin acentos
  busqueda    tsvector generated always as (
    to_tsvector('simple',
      public.f_unaccent(nombres || ' ' || apellidos || ' ' || coalesce(documento,'')))
  ) stored
);

create index pacientes_busqueda_idx on public.pacientes using gin (busqueda);
-- Trigram para tolerar errores de tipeo
create index pacientes_trgm_idx on public.pacientes
  using gin (public.f_unaccent(nombres || ' ' || apellidos) extensions.gin_trgm_ops);

-- El correlativo es INMUTABLE: cualquier intento de UPDATE falla
create or replace function public.proteger_correlativo()
returns trigger language plpgsql
as $$
begin
  if new.correlativo <> old.correlativo then
    raise exception 'El correlativo es inmutable';
  end if;
  return new;
end $$;

create trigger trg_correlativo_inmutable
  before update on public.pacientes
  for each row execute function public.proteger_correlativo();

-- ---------- jornadas ----------
create table public.jornadas (
  id      bigint generated always as identity primary key,
  fecha   date not null,
  equipo  text not null check (equipo in ('A','B','C','D')),
  abierta boolean not null default true,
  unique (fecha, equipo)
);

-- ---------- visitas (eventos de demanda) ----------
create table public.visitas (
  id             uuid primary key default gen_random_uuid(),
  paciente_id    uuid not null references public.pacientes(id),
  jornada_id     bigint not null references public.jornadas(id),
  fecha_hora     timestamptz not null default now(),
  tipo_atencion  text not null default 'consulta'
                 check (tipo_atencion in ('consulta','emergencia','control','otro')),
  es_primera_vez boolean not null default false,
  usuario_id     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now()
);

create index visitas_jornada_idx  on public.visitas (jornada_id);
create index visitas_paciente_idx on public.visitas (paciente_id);

-- ---------- modelos (métricas de entrenamiento) ----------
create table public.modelos (
  id           bigint generated always as identity primary key,
  creado       timestamptz not null default now(),
  mae          double precision not null,
  rmse         double precision not null,
  r2           double precision not null,
  n_filas      integer not null,
  storage_path text not null
);

-- ---------- auditoria ----------
create table public.auditoria (
  id          bigint generated always as identity primary key,
  usuario_id  uuid,
  accion      text not null,
  tabla       text not null,
  registro_id text not null,
  datos       jsonb,
  creado      timestamptz not null default now()
);

create or replace function public.fn_auditoria()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare fila record;
begin
  if tg_op = 'DELETE' then fila := old; else fila := new; end if;
  insert into public.auditoria (usuario_id, accion, tabla, registro_id, datos)
  values (
    auth.uid(), tg_op, tg_table_name,
    (to_jsonb(fila) ->> 'id'),
    case tg_op
      when 'DELETE' then to_jsonb(old)
      when 'UPDATE' then jsonb_build_object('antes', to_jsonb(old), 'despues', to_jsonb(new))
      else to_jsonb(new)
    end
  );
  return null; -- trigger AFTER: el valor de retorno se ignora
end $$;

create trigger trg_audit_pacientes
  after insert or update or delete on public.pacientes
  for each row execute function public.fn_auditoria();

create trigger trg_audit_visitas
  after insert or update or delete on public.visitas
  for each row execute function public.fn_auditoria();

-- ---------- Vista de demanda (dataset de entrenamiento) ----------
create view public.v_demanda_por_turno
with (security_invoker = true) as
select j.id as jornada_id, j.fecha, j.equipo, count(v.id)::int as pacientes
from public.jornadas j
join public.visitas v on v.jornada_id = j.id
group by j.id, j.fecha, j.equipo;

-- ============================================================
-- RPCs
-- ============================================================

-- Abre u obtiene la jornada del día para un equipo (atómico via upsert)
create or replace function public.obtener_jornada(p_equipo text)
returns bigint language sql security definer
set search_path = ''
as $$
  insert into public.jornadas (fecha, equipo)
  values ((now() at time zone 'America/Guatemala')::date, p_equipo)
  on conflict (fecha, equipo) do update set abierta = public.jornadas.abierta
  returning id;
$$;
revoke execute on function public.obtener_jornada from public, anon, authenticated;

-- Búsqueda de pacientes: full-text + trigram (tolera tildes y typos).
-- Devuelve SOLO campos de desambiguación. La usan Admisión (digitador) y
-- Consulta (estadistica); admin todo. La resolución por DPI queda limitada
-- a admin (abajo), así que dar acceso a estadistica no reabre ese oráculo.
create or replace function public.buscar_paciente(q text)
returns table (id uuid, correlativo bigint, nombres text, apellidos text)
language plpgsql stable security definer
set search_path = ''
as $$
declare qn text;
begin
  if public.rol() not in ('digitador','estadistica','admin') then
    raise exception 'No autorizado';
  end if;
  qn := public.f_unaccent(trim(q));
  if qn is null or qn = '' then return; end if;

  return query
  select p.id, p.correlativo, p.nombres, p.apellidos
  from public.pacientes p
  where p.busqueda @@ websearch_to_tsquery('simple', qn)
     or public.f_unaccent(p.nombres || ' ' || p.apellidos) operator(extensions.%) qn
     or p.correlativo::text = trim(q)
     or (public.rol() = 'admin' and p.documento = trim(q))
  order by
    greatest(
      ts_rank(p.busqueda, websearch_to_tsquery('simple', qn)),
      extensions.similarity(public.f_unaccent(p.nombres || ' ' || p.apellidos), qn)
    ) desc
  limit 20;
end $$;
revoke execute on function public.buscar_paciente from public, anon;
grant  execute on function public.buscar_paciente to authenticated;

-- Registro atómico de paciente NUEVO + primera visita.
create or replace function public.registrar_paciente(
  p_nombres text, p_apellidos text, p_documento text,
  p_equipo text, p_tipo_atencion text
) returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_paciente public.pacientes; v_jornada bigint; v_visita uuid;
begin
  -- MFA (aal2) exigido en el SERVIDOR, no solo en el gate React.
  -- Si el usuario tiene un factor verificado (TOTP inscrito), su token
  -- debe ser aal2; quien nunca inscribió MFA no se ve afectado.
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
     and exists (
       select 1 from auth.mfa_factors f
       where f.user_id = auth.uid() and f.status = 'verified'
     ) then
    raise exception 'Requiere autenticación de segundo factor (aal2)';
  end if;
  if public.rol() not in ('digitador','admin') then
    raise exception 'No autorizado';
  end if;

  insert into public.pacientes (nombres, apellidos, documento)
  values (trim(p_nombres), trim(p_apellidos), nullif(trim(p_documento), ''))
  returning * into v_paciente;

  v_jornada := public.obtener_jornada(p_equipo);

  insert into public.visitas (paciente_id, jornada_id, tipo_atencion, es_primera_vez, usuario_id)
  values (v_paciente.id, v_jornada, p_tipo_atencion, true, auth.uid())
  returning id into v_visita;

  return jsonb_build_object(
    'paciente_id', v_paciente.id,
    'correlativo', v_paciente.correlativo,
    'visita_id', v_visita
  );
end $$;
revoke execute on function public.registrar_paciente from public, anon;
grant  execute on function public.registrar_paciente to authenticated;

-- Registro de visita de paciente EXISTENTE ("vino de nuevo").
create or replace function public.registrar_visita(
  p_paciente_id uuid, p_equipo text, p_tipo_atencion text
) returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_jornada bigint; v_visita uuid;
begin
  -- MFA (aal2) exigido en el SERVIDOR, no solo en el gate React.
  -- Si el usuario tiene un factor verificado (TOTP inscrito), su token
  -- debe ser aal2; quien nunca inscribió MFA no se ve afectado.
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
     and exists (
       select 1 from auth.mfa_factors f
       where f.user_id = auth.uid() and f.status = 'verified'
     ) then
    raise exception 'Requiere autenticación de segundo factor (aal2)';
  end if;
  if public.rol() not in ('digitador','admin') then
    raise exception 'No autorizado';
  end if;

  v_jornada := public.obtener_jornada(p_equipo);

  insert into public.visitas (paciente_id, jornada_id, tipo_atencion, es_primera_vez, usuario_id)
  values (p_paciente_id, v_jornada, p_tipo_atencion, false, auth.uid())
  returning id into v_visita;

  return jsonb_build_object('visita_id', v_visita);
end $$;
revoke execute on function public.registrar_visita from public, anon;
grant  execute on function public.registrar_visita to authenticated;

-- ============================================================
-- RLS — deny-by-default en TODAS las tablas
-- ============================================================
alter table public.perfiles  enable row level security;
alter table public.pacientes enable row level security;
alter table public.jornadas  enable row level security;
alter table public.visitas   enable row level security;
alter table public.modelos   enable row level security;
alter table public.auditoria enable row level security;

-- perfiles: cada usuario ve/edita el suyo; admin gestiona todos.
create policy perfiles_select_propio on public.perfiles
  for select to authenticated
  using (id = auth.uid() or public.rol() = 'admin');
create policy perfiles_update_propio on public.perfiles
  for update to authenticated
  using (id = auth.uid() or public.rol() = 'admin')
  -- nadie se cambia su propio rol; solo admin (rol() es SECURITY DEFINER:
  -- sin subconsulta directa a perfiles, que causaría recursión RLS)
  with check (public.rol() = 'admin' or rol = public.rol());
create policy perfiles_admin_all on public.perfiles
  for all to authenticated
  using (public.rol() = 'admin') with check (public.rol() = 'admin');
-- el hook de auth (supabase_auth_admin) necesita leer el rol
create policy perfiles_auth_admin on public.perfiles
  for select to supabase_auth_admin using (true);
grant select on public.perfiles to supabase_auth_admin;

-- pacientes: digitador busca/SELECT e INSERT (sin DELETE);
-- estadistica SELECT; admin todo.
create policy pacientes_select on public.pacientes
  for select to authenticated
  using (public.rol() in ('digitador','estadistica','admin') and public.mfa_ok());
-- Escritura directa por PostgREST cerrada: la creación de pacientes debe
-- pasar por la RPC registrar_paciente (SECURITY DEFINER, corre como owner
-- y salta este revoke) para no evadir su validación ni envenenar el
-- dataset de demanda. Sin el grant de INSERT la política pacientes_insert
-- quedaría inefectiva, por eso se elimina. UPDATE/DELETE siguen siendo
-- solo-admin (conservan su grant) para permitir corrección manual.
revoke insert on public.pacientes from authenticated;
create policy pacientes_update_admin on public.pacientes
  for update to authenticated
  using (public.rol() = 'admin' and public.mfa_ok()) with check (public.rol() = 'admin' and public.mfa_ok());
create policy pacientes_delete_admin on public.pacientes
  for delete to authenticated
  using (public.rol() = 'admin' and public.mfa_ok());

-- Minimización a nivel de columna: nadie lee el DPI/CUI vía PostgREST
-- directo. La RLS de fila ya limita qué filas, pero sin esto un digitador
-- podría hacer select('*') y exfiltrar documentos. Las RPCs SECURITY
-- DEFINER (buscar_paciente, registrar_*) sí acceden a documento porque
-- corren como owner y saltan estos grants; es la única vía de lectura.
revoke select on public.pacientes from authenticated;
grant select (id, correlativo, nombres, apellidos, created_at)
  on public.pacientes to authenticated;

-- jornadas: lectura para todos los roles internos (necesaria para
-- consultas y la vista); escritura solo vía RPC (security definer).
create policy jornadas_select on public.jornadas
  for select to authenticated
  using (public.rol() in ('digitador','estadistica','admin') and public.mfa_ok());

-- visitas: digitador INSERT y SELECT de lo suyo; estadistica SELECT
-- de todo; admin todo.
create policy visitas_select on public.visitas
  for select to authenticated
  using (
    (public.rol() in ('estadistica','admin')
     or (public.rol() = 'digitador' and usuario_id = auth.uid()))
    and public.mfa_ok()
  );
-- Escritura directa por PostgREST cerrada: el alta de visitas debe pasar
-- por la RPC registrar_visita (SECURITY DEFINER, corre como owner y salta
-- este revoke) para no evadir su validación ni envenenar el dataset de
-- demanda. Sin el grant de INSERT la política visitas_insert quedaría
-- inefectiva, por eso se elimina. UPDATE/DELETE siguen siendo solo-admin
-- (conservan su grant) para permitir corrección manual.
revoke insert on public.visitas from authenticated;
create policy visitas_update_admin on public.visitas
  for update to authenticated
  using (public.rol() = 'admin' and public.mfa_ok()) with check (public.rol() = 'admin' and public.mfa_ok());
create policy visitas_delete_admin on public.visitas
  for delete to authenticated
  using (public.rol() = 'admin' and public.mfa_ok());

-- modelos: lectura para estadistica y admin. Escribe solo service_role.
create policy modelos_select on public.modelos
  for select to authenticated
  using (public.rol() in ('estadistica','admin') and public.mfa_ok());

-- auditoria: solo admin lee; nadie modifica (inserta el trigger
-- SECURITY DEFINER; sin políticas de INSERT/UPDATE/DELETE).
create policy auditoria_select_admin on public.auditoria
  for select to authenticated
  using (public.rol() = 'admin' and public.mfa_ok());

-- ============================================================
-- Notas post-instalación (Dashboard):
-- 1. Authentication > Hooks: activar custom_access_token_hook
--    (ejecutar antes auth_hook.sql).
-- 2. Authentication > Providers > Email: confirmación obligatoria.
-- 3. Authentication > Providers: activar 'Disable sign ups'
--    (OBLIGATORIO). El registro público NO debe quedar abierto: al
--    crearse un usuario, el trigger on_auth_user_created lo provisiona
--    con rol 'digitador', que ya tiene acceso operativo al padrón de
--    pacientes. Con el alta pública abierta, cualquiera obtendría ese
--    acceso. Los usuarios deben crearlos solo un admin (invitación) o
--    el service_role. Documentar también en el README.
-- 4. Authentication > Policies: contraseña mínima 12 + protección
--    de contraseñas filtradas (HaveIBeenPwned).
-- 5. Authentication > MFA: habilitar TOTP.
-- 6. Storage: crear bucket PRIVADO llamado "modelos".
-- ============================================================
