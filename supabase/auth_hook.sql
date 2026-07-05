-- ============================================================
-- Custom Access Token Hook: inyecta el rol como claim `user_rol`
-- dentro del JWT. Así las políticas RLS leen el rol con
-- auth.jwt() ->> 'user_rol' sin subconsultas a perfiles.
--
-- Después de ejecutar este script, activarlo en:
-- Dashboard > Authentication > Hooks > Custom Access Token
-- ============================================================

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  claims jsonb;
  v_rol  text;
begin
  select rol into v_rol
  from public.perfiles
  where id = (event ->> 'user_id')::uuid;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  claims := jsonb_set(claims, '{user_rol}', to_jsonb(coalesce(v_rol, 'digitador')));
  return jsonb_set(event, '{claims}', claims);
end $$;

-- Solo el servicio de Auth puede ejecutarlo
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
