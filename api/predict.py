"""Funcion serverless de inferencia (Vercel, plan Hobby: <10 s).

- Verifica el JWT de Supabase (Authorization: Bearer) antes de todo.
- CORS restringido al origin del frontend (nunca *).
- Descarga modelo-latest.joblib del bucket PRIVADO con la service_role
  key (solo server-side) y lo cachea en memoria entre invocaciones.
"""

import io
import json
import os
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

import joblib
import jwt
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173")

BUCKET = "modelos"
MODEL_PATH = "modelo-latest.joblib"
EQUIPO_MAP = {"A": 0, "B": 1, "C": 2, "D": 3}
TZ_GT = timezone(timedelta(hours=-6))

# Feriados GT — duplicado de ml/feriados.py (la funcion se despliega aislada)
FERIADOS_GT = {(1, 1), (5, 1), (6, 30), (9, 15), (10, 20), (11, 1),
               (12, 24), (12, 25), (12, 31)}
FERIADOS_MOVILES = {date(2025, 4, 17), date(2025, 4, 18),
                    date(2026, 4, 2), date(2026, 4, 3)}

# Fraccion acumulada de visitas esperadas al FINAL de cada hora (0-23),
# derivada del patron historico de llegadas (picos manana y media tarde).
_PESOS = [1, 1, 1, 1, 2, 3, 6, 10, 12, 12, 10, 8, 6, 7, 9, 10, 8, 6, 4, 3, 2, 2, 1, 1]
_TOTAL = sum(_PESOS)
CUM_HORA = [sum(_PESOS[: h + 1]) / _TOTAL for h in range(24)]

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_methods=["GET"],
    allow_headers=["Authorization", "Content-Type"],
)

_cache = {}  # modelo cacheado entre invocaciones warm


def _http_get(url: str, headers: dict | None = None, timeout: float = 5.0):
    # ponytail: urllib en vez de supabase-py; ese paquete arrastra ~70 MB
    # (cryptography, httpx, realtime...) y revienta el limite de 225 MB de la
    # funcion. Devuelve la respuesta (usar como context manager).
    h = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
    if headers:
        h.update(headers)
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)


def _count_de(content_range: str) -> int:
    # PostgREST devuelve "0-24/573" o "*/0"; extrae el total tras la barra
    cola = content_range.rsplit("/", 1)[-1] if "/" in content_range else ""
    return int(cola) if cola.isdigit() else 0


def verificar_jwt(request: Request) -> dict:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "Token requerido")
    try:
        claims = jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"],
                            audience="authenticated")
    except jwt.PyJWTError:
        raise HTTPException(401, "Token inválido o expirado")

    # El cliente service_role omite RLS, así que las guardas que en la BD
    # aplican public.rol()/public.mfa_ok() deben replicarse aquí; si no, el
    # gate del frontend (RequireRole) es el único control y se puede saltar.
    sub = claims.get("sub", "")

    # RBAC: solo estadistica/admin (paridad con RequireRole y las políticas
    # de la tabla modelos). Un digitador no debe leer métricas ni nowcast.
    if claims.get("user_rol") not in ("estadistica", "admin"):
        raise HTTPException(403, "Rol no autorizado")

    # Rate limiting por sub: ventana deslizante de 1 min en estado de módulo
    # (persiste en instancias warm). Acota abuso de cómputo/pooler.
    import time
    now_ts = time.time()
    ventana = _cache.setdefault("_rl", {})
    hits = [t for t in ventana.get(sub, ()) if now_ts - t < 60.0]
    hits.append(now_ts)
    ventana[sub] = hits
    if len(hits) > 60:
        raise HTTPException(429, "Demasiadas solicitudes; reintentá en un minuto")

    # MFA: exigir aal2, pero solo a quien tiene un factor verificado (paridad
    # con public.mfa_ok()), para no romper a quien no inscribió TOTP. El
    # estado de inscripción no viaja en el JWT, así que se consulta al Admin
    # API de Auth (service_role) y se cachea con TTL. Fail-open ante error de
    # red para no bloquear a usuarios legítimos por una falla transitoria.
    if sub and claims.get("aal") != "aal2":
        mfa_cache = _cache.setdefault("_mfa", {})
        cached = mfa_cache.get(sub)
        if cached is None or now_ts - cached[1] > 300.0:
            inscrito = False
            try:
                with _http_get(f"{SUPABASE_URL}/auth/v1/admin/users/{sub}",
                               timeout=3) as resp:
                    factores = json.loads(resp.read()).get("factors") or []
                inscrito = any(f.get("status") == "verified" for f in factores)
            except Exception:
                inscrito = False  # fail-open: no romper si Auth no responde
            cached = (inscrito, now_ts)
            mfa_cache[sub] = cached
        if cached[0]:
            raise HTTPException(403, "Se requiere verificación en dos pasos (aal2)")

    return claims


def cargar_modelo() -> dict:
    if "bundle" not in _cache:
        url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{MODEL_PATH}"
        with _http_get(url, timeout=8) as resp:
            data = resp.read()
        _cache["bundle"] = joblib.load(io.BytesIO(data))
    return _cache["bundle"]


def es_feriado(d: date) -> int:
    return int((d.month, d.day) in FERIADOS_GT or d in FERIADOS_MOVILES)


def features_de(d: date, equipo: str) -> list:
    return [[d.weekday(), d.month, d.isocalendar()[1], es_feriado(d), EQUIPO_MAP[equipo]]]


class Prediccion(BaseModel):
    prediccion: float
    equipo: str
    fecha: date
    modelo: dict


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/predict", response_model=Prediccion)
def predict(
    fecha: date = Query(...),
    equipo: str = Query(..., pattern="^[ABCD]$"),
    claims: dict = Depends(verificar_jwt),
):
    if claims.get("user_rol") not in ("estadistica", "admin"):
        raise HTTPException(403, "Rol no autorizado")
    bundle = cargar_modelo()
    pred = bundle["model"].predict(features_de(fecha, equipo))[0]
    return Prediccion(
        prediccion=round(max(0.0, float(pred)), 1),
        equipo=equipo, fecha=fecha, modelo=bundle["metrics"],
    )


@app.get("/api/nowcast")
def nowcast(claims: dict = Depends(verificar_jwt)):
    """Estimacion viva de la jornada EN CURSO: visitas registradas hasta
    ahora escaladas por la fraccion historica de la hora transcurrida."""
    if claims.get("user_rol") not in ("estadistica", "admin"):
        raise HTTPException(403, "Rol no autorizado")
    ahora = datetime.now(TZ_GT)

    # rate limit por sub: max 30 req/min. Reutiliza estado en instancias
    # warm via _cache (dict de modulo ya existente); en frias se reinicia.
    sub = claims.get("sub", "")
    _rl = _cache.setdefault("rl", {})
    hist = [t for t in _rl.get(sub, []) if ahora.timestamp() - t < 60]
    if len(hist) >= 30:
        raise HTTPException(429, "Demasiadas solicitudes")
    hist.append(ahora.timestamp())
    _rl[sub] = hist

    # order determinista: si hay varias jornadas abiertas hoy (varios
    # equipos), toma la más reciente en vez de una fila arbitraria.
    q = urllib.parse.urlencode({
        "select": "id,equipo",
        "fecha": f"eq.{ahora.date().isoformat()}",
        "abierta": "eq.true",
        "order": "id.desc",
        "limit": "1",
    })
    with _http_get(f"{SUPABASE_URL}/rest/v1/jornadas?{q}") as resp:
        jor = json.loads(resp.read())
    if not jor:
        return {"jornada_abierta": False}

    # solo el conteo: limit=1 (traer 1 fila) + Prefer count=exact -> Content-Range
    q = urllib.parse.urlencode({"select": "id", "jornada_id": f"eq.{jor[0]['id']}",
                                "limit": "1"})
    with _http_get(f"{SUPABASE_URL}/rest/v1/visitas?{q}",
                   headers={"Prefer": "count=exact"}) as resp:
        n = _count_de(resp.headers.get("Content-Range", ""))

    # ponytail: perfil horario fijo (mismo del seed); si la realidad
    # difiere, calcular el perfil desde visitas historicas.
    frac = max(CUM_HORA[ahora.hour], 0.02)
    return {
        "jornada_abierta": True,
        "equipo": jor[0]["equipo"],
        "visitas_actuales": n,
        "total_estimado": round(n / frac),
        "hora": ahora.strftime("%H:%M"),
    }


if __name__ == "__main__":
    assert _count_de("0-24/573") == 573
    assert _count_de("*/0") == 0
    assert _count_de("0-0/1") == 1
    assert _count_de("") == 0
    print("ok")
