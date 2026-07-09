# Modelo de seguridad

Seguridad integrada desde el diseño (*security by design*), no como añadido. Este
documento describe el modelo completo. Para el detalle del esquema ver
[BASE-DE-DATOS](./BASE-DE-DATOS.md); para activar cada opción en el Dashboard, el
[README](../README.md).

## Autenticación

- **Supabase Auth** con email + contraseña.
- **Confirmación de correo obligatoria** (Dashboard → Authentication → Email).
- **Política de contraseñas**: longitud mínima **12** y **protección contra
  contraseñas filtradas** (HaveIBeenPwned / HIBP) activada en la config de Auth.
- **MFA (TOTP)** habilitado y ofrecido a los roles `admin` y `estadistica` desde
  la pantalla de Seguridad (`MfaSetup.tsx`, alta con QR).
- **JWT de vida corta** con rotación de refresh token (defaults de Supabase). El
  cierre de sesión (`supabase.auth.signOut()`) invalida la sesión local.

### Cómo se fuerza el segundo factor (aal2)

Iniciar sesión con contraseña deja la sesión en `aal1`. Si el usuario tiene un
factor TOTP verificado, `AuthProvider` detecta con
`getAuthenticatorAssuranceLevel()` que `nextLevel === 'aal2'` y expone
`needsMfa = true`. Mientras `needsMfa` sea verdadero:

- `RequireRole` redirige a `/login` (no muestra ninguna pantalla protegida).
- `Login` fuerza la fase del segundo factor aunque se navegue directo, cerrando
  el hueco de "saltarse el MFA yendo a otra ruta".

Tras verificar el TOTP la sesión sube a `aal2`, `onAuthStateChange` refresca el
estado y el acceso se habilita.

**Enforcement en el servidor (no solo en el cliente).** El gate de `RequireRole`
es UX; el control efectivo vive en la base de datos y la API para que un token
`aal1` robado no sirva ni yendo directo a PostgREST:

- El helper `public.mfa_ok()` (`SECURITY DEFINER`, `search_path=''`) devuelve
  `true` si el token es `aal2` **o** si el usuario no tiene ningún factor
  `verified` en `auth.mfa_factors`. Así se exige `aal2` solo a quien inscribió
  TOTP, sin romper a los digitadores sin MFA.
- Todas las políticas RLS de `pacientes`, `visitas`, `jornadas`, `modelos` y
  `auditoria` añaden `and public.mfa_ok()`.
- Las RPCs `registrar_paciente` y `registrar_visita` rechazan con excepción si
  falta `aal2` teniendo factor inscrito (guarda inline antes del chequeo de rol).
- `api/predict.py` (`verificar_jwt`) devuelve **403** si `aal != aal2` y el
  usuario tiene MFA inscrito; consulta el Admin API de Auth (service_role) para
  saberlo y cachea 300 s. Es *fail-open* ante caída de Auth para no bloquear a
  usuarios legítimos; el control autoritativo sigue siendo `mfa_ok()` en la BD.

El diseño es *fail-safe* frente a un claim `aal` ausente: `coalesce(..., 'aal1')`
trata el token sin `aal` como `aal1` (deniega, no abre).

## RBAC (control de acceso por rol)

- Roles: `digitador`, `estadistica`, `admin`, guardados en la tabla `perfiles`.
- Un trigger crea el perfil al registrarse el usuario (rol por defecto
  `digitador`). Promover a otro rol se hace editando `perfiles` (solo admin).
- **El registro público debe estar deshabilitado** (Dashboard → Authentication →
  *Disable sign ups*). Como el trigger provisiona `digitador` —que ya tiene
  acceso al padrón—, dejar el alta abierta daría ese acceso a cualquiera. Los
  usuarios los crea solo un admin (invitación) o el `service_role`.
- El **Custom Access Token Hook** (`auth_hook.sql`) inyecta el rol como claim
  **`user_rol`** dentro del JWT.
- La función `public.rol()` lee ese claim (`auth.jwt() ->> 'user_rol'`), con
  fallback `SECURITY DEFINER` a `perfiles` si el claim aún no está. Las políticas
  RLS usan `public.rol()` en vez de subconsultas a `perfiles`: evita recursión RLS
  y mejora el rendimiento.
- **Privilegio mínimo**: cada rol accede solo a lo que necesita (ver tabla RLS en
  [BASE-DE-DATOS](./BASE-DE-DATOS.md#políticas-rls-por-rol)).

> Un cambio de rol solo entra al JWT tras **reiniciar sesión**.

## RLS — deny-by-default

Todas las tablas tienen RLS activo y ninguna se deja sin políticas. Resumen:

| Tabla | digitador | estadistica | admin |
|---|---|---|---|
| `pacientes` | SELECT (sin columna `documento`) | SELECT (sin `documento`) | todo |
| `visitas` | SELECT **de lo suyo** (`usuario_id = auth.uid()`) | SELECT de todo | todo |
| `jornadas` | SELECT | SELECT | SELECT (escritura solo por RPC) |
| `perfiles` | ve/edita el suyo | ve/edita el suyo | gestiona todos |
| `modelos` | — | SELECT | SELECT |
| `auditoria` | — | — | SELECT (nadie modifica) |

Toda política (salvo `perfiles`) exige además `public.mfa_ok()`.

**Sin escritura directa por PostgREST.** El `INSERT` directo a `pacientes` y
`visitas` está **revocado** (`revoke insert ... from authenticated`): el alta pasa
obligatoriamente por las RPCs `SECURITY DEFINER` (`registrar_paciente`,
`registrar_visita`), que validan rol y `aal2` y corren como owner. Esto evita
evadir su lógica y **envenenar el dataset de demanda** con inserciones crudas.
`UPDATE`/`DELETE` quedan solo para `admin` (corrección manual).

## Minimización de columnas (DPI/CUI)

Aunque `pacientes` es legible por los roles internos, la columna `documento`
(DPI/CUI) **no se expone por SELECT directo**: tras el `revoke`, el `grant` de
columna solo incluye `id, correlativo, nombres, apellidos, created_at`. Sin esto un
digitador podría hacer `select('*')` y exfiltrar todos los documentos. Solo las
RPCs `SECURITY DEFINER` (que corren como owner y saltan el grant) acceden a
`documento`. Para mostrar el DPI a algún rol, crear una RPC dedicada — no reabrir
el grant.

## Auditoría

La tabla `auditoria` registra `usuario_id`, `accion`, `tabla`, `registro_id`,
`datos` (jsonb) y `creado`. Triggers `AFTER INSERT/UPDATE/DELETE` sobre `pacientes`
y `visitas` escriben cada cambio con `auth.uid()`. En UPDATE guarda `{antes, despues}`.
Nadie puede modificar `auditoria`: el insert lo hace el trigger `SECURITY DEFINER`
y no existen políticas de INSERT/UPDATE/DELETE para usuarios; solo `admin` lee.

## Secretos y superficie de ataque

- La **`service_role` key** vive SOLO en secrets de GitHub Actions y en env vars
  server-side de Vercel (usada por `train.py`, `seed.py`, `api/predict.py`). Nunca
  con prefijo `VITE_`, nunca en el bundle del frontend.
- El frontend usa solo la **`anon` key** (pública por diseño; RLS protege los datos).
- El **bucket `modelos`** de Storage es **privado**; se accede solo con la
  `service_role` desde `train.py` (escribe) y `predict.py` (lee).

## API de inferencia

`api/predict.py` es pública en URL, por lo que:

- **Verifica el JWT** del header `Authorization: Bearer` antes de responder
  (`PyJWKClient` + `jwt.decode` con **ES256** contra el JWKS del proyecto y
  `audience="authenticated"`). Sin token válido → **401**.
- **Enforcea el rol server-side**: como usa la `service_role` (que omite RLS),
  replica el control de acceso — solo `estadistica`/`admin` acceden a `/api/predict`
  y `/api/nowcast`; un `digitador` recibe **403**. Sin esto, saltarse RLS con la
  service_role dejaría el gate solo en el cliente.
- **Exige `aal2`** para usuarios con MFA inscrito (ver enforcement de segundo factor).
- **Rate limiting** por `sub` del JWT (ventana deslizante en memoria) → **429** al
  exceder; acota abuso de cómputo y presión sobre el pooler en el free tier.
- **CORS restringido** al origin del frontend (`FRONTEND_ORIGIN`), nunca `*`.
- `/api/health` no expone datos sensibles.

> **JWT — validación por JWKS (ES256):** el proyecto usa las *JWT Signing Keys*
> asimétricas de Supabase. `verificar_jwt` obtiene la clave pública del JWKS
> (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`) con `PyJWKClient` y valida en
> ES256. Requiere `pyjwt[crypto]` y `SUPABASE_URL` en el entorno; ya no se usa
> `SUPABASE_JWT_SECRET`.

## Cabeceras de seguridad HTTP

`vercel.json` aplica a todas las rutas (`/(.*)`):

- **Content-Security-Policy** restrictiva: `default-src 'self'`, `script-src
  'self'`, `connect-src` limitado a `*.supabase.co` (y wss para realtime),
  `frame-ancestors 'none'` (anti-clickjacking), `object-src 'none'`, `base-uri
  'self'`. Reduce la superficie de exfiltración del token de `localStorage` ante
  un XSS (no reemplaza corregir el XSS).
- **X-Content-Type-Options: nosniff**.
- **Strict-Transport-Security** (HSTS) con `max-age` de 2 años + `preload`.

## TLS

Vercel y Supabase sirven todo sobre **HTTPS/TLS** por defecto; no hay tramos en
claro entre frontend, API y base de datos.

## Datos y cumplimiento

- **Minimización, finalidad y proporcionalidad**: solo se guardan los datos de
  identidad estrictamente necesarios para reconocer a un paciente que regresa
  (nombres, apellidos, DPI/CUI opcional). **Sin diagnósticos ni datos clínicos.**
- Marco de referencia: **Ley de Acceso a la Información Pública de Guatemala
  (Decreto 57-2008)**, en particular la protección de datos personales sensibles.
  En despliegue real, el manejo de datos de menores debe regirse por las
  salvaguardas de protección de datos de la institución.

## Respaldo

El free tier no tiene point-in-time recovery. `backup.yml` hace un dump lógico
semanal como artifact (retención 30 días).

> **Endurecimiento pendiente:** el dump contiene datos personales; los artifacts de
> GitHub solo son descargables con acceso al repo, pero para producción conviene
> **cifrarlo** antes de subir (p. ej. `gpg --symmetric`) y guardar la passphrase
> como secret.

## Endurecimientos pendientes (resumen)

Ya implementados tras la auditoría: `aal2` a nivel de RLS/RPC/API, RBAC en la API,
cierre de escritura directa por PostgREST, cabeceras CSP/HSTS/nosniff y rate
limiting. Quedan como acciones fuera del código:

1. **Deshabilitar el registro público** en el Dashboard (Authentication →
   *Disable sign ups*) — obligatorio, no derivable del SQL.
2. **Cifrar los backups** antes de subirlos como artifact (`gpg --symmetric`).
3. **Rotar las *JWT Signing Keys*** de Supabase periódicamente (la validación ya
   es por JWKS/ES256).
4. **Fijar versiones** en `ml/requirements.txt` para builds de entrenamiento
   reproducibles (la función de Vercel ya no deserializa el modelo, así que no
   depende de que las versiones de `scikit-learn` coincidan).
5. **Rate limit consistente entre instancias** (tabla/Redis) si el free tier de
   Vercel escala a varias instancias frías.
6. **Rotación manual** de `SUPABASE_SERVICE_KEY` (y de las *JWT Signing Keys*) si
   pudieron exponerse (Dashboard → Settings → API, y actualizar env vars en Vercel
   y GitHub Actions).
