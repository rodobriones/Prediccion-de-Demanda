"""Genera 18 meses de datos sinteticos: pacientes + jornadas + visitas.

Uso:
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python ml/seed.py

Inserta con la service_role key (bypassa RLS; solo para seed/ops).
"""

import os
import random
import sys
import uuid
from datetime import date, datetime, timedelta, timezone

from supabase import create_client

from feriados import es_feriado

random.seed(42)

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

DIAS = 540  # ~18 meses
EQUIPOS = ["A", "B", "C", "D"]  # rotacion diaria
P_PRIMERA_VEZ = 0.40
TIPOS = ["consulta"] * 6 + ["emergencia"] * 2 + ["control"] * 2

NOMBRES_M = ["José", "Luis", "Carlos", "Juan", "Miguel", "Pedro", "Mario", "Jorge",
             "Byron", "Erick", "Édgar", "Óscar", "Sergio", "Manuel", "Rodrigo",
             "Kevin", "Wilson", "Selvin", "Marvin", "Estuardo"]
NOMBRES_F = ["María", "Ana", "Rosa", "Carmen", "Juana", "Silvia", "Gloria", "Mirna",
             "Lucía", "Andrea", "Sofía", "Karla", "Wendy", "Ingrid", "Heidy",
             "Dina", "Marta", "Telma", "Yesenia", "Águeda"]
APELLIDOS = ["García", "López", "Pérez", "Hernández", "Morales", "Ramírez", "Xicará",
             "Chocón", "Tzul", "Ajanel", "Cojtí", "Batz", "Chávez", "Castañeda",
             "Monzón", "De León", "Estrada", "Sicán", "Toc", "Ixchop", "Us",
             "Poyón", "Sipac", "Velásquez", "Ordóñez"]

# Distribución de horas de llegada: picos en la mañana y media tarde
HORAS = list(range(24))
PESO_HORA = [1, 1, 1, 1, 2, 3, 6, 10, 12, 12, 10, 8, 6, 7, 9, 10, 8, 6, 4, 3, 2, 2, 1, 1]


def nuevo_paciente():
    nombres = f"{random.choice(NOMBRES_M + NOMBRES_F)} {random.choice(NOMBRES_M + NOMBRES_F)}"
    apellidos = f"{random.choice(APELLIDOS)} {random.choice(APELLIDOS)}"
    # ~25% llega sin DPI/CUI (documento opcional, no único)
    documento = None if random.random() < 0.25 else "".join(random.choices("0123456789", k=13))
    return {
        "id": str(uuid.uuid4()),
        "nombres": nombres,
        "apellidos": apellidos,
        "documento": documento,
    }


def visitas_del_dia(fecha: date) -> int:
    base = 65
    dow = fecha.weekday()
    if dow in (0, 4):      # lunes y viernes más altos
        base += 15
    elif dow in (5, 6):    # fin de semana más bajo
        base -= 15
    if es_feriado(fecha):
        base -= 25
    return max(15, base + random.randint(-12, 12))


def hora_llegada(fecha: date) -> str:
    h = random.choices(HORAS, weights=PESO_HORA)[0]
    dt = datetime(fecha.year, fecha.month, fecha.day, h,
                  random.randint(0, 59), random.randint(0, 59),
                  tzinfo=timezone(timedelta(hours=-6)))  # America/Guatemala
    return dt.isoformat()


def main():
    sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    inicio = date.today() - timedelta(days=DIAS)
    pacientes, jornadas, visitas = [], [], []
    pool = []  # pacientes ya registrados (para visitas recurrentes)

    for i in range(DIAS):
        fecha = inicio + timedelta(days=i)
        equipo = EQUIPOS[i % 4]
        jornadas.append({"fecha": fecha.isoformat(), "equipo": equipo, "abierta": False})

        for _ in range(visitas_del_dia(fecha)):
            # ponytail: p=0.40 fijo => ~40% primeras visitas como pide el spec;
            # el total de pacientes queda en ~14k (el "~2000" del enunciado es
            # incompatible con 18 meses x 40% nuevas; primó la mezcla).
            if not pool or random.random() < P_PRIMERA_VEZ:
                p = nuevo_paciente()
                pacientes.append(p)
                pool.append(p["id"])
                pid, primera = p["id"], True
            else:
                pid, primera = random.choice(pool), False
            visitas.append({
                "paciente_id": pid,
                "jornada": (fecha.isoformat(), equipo),
                "fecha_hora": hora_llegada(fecha),
                "tipo_atencion": random.choice(TIPOS),
                "es_primera_vez": primera,
            })

    print(f"Generado: {len(pacientes)} pacientes, {len(jornadas)} jornadas, {len(visitas)} visitas")

    def chunked(rows, tabla, n=500):
        for k in range(0, len(rows), n):
            sb.table(tabla).insert(rows[k:k + n]).execute()
            print(f"  {tabla}: {min(k + n, len(rows))}/{len(rows)}", end="\r")
        print()

    chunked(pacientes, "pacientes")
    chunked(jornadas, "jornadas")

    # mapa (fecha, equipo) -> jornada_id
    jmap = {}
    for k in range(0, DIAS, 1000):
        res = sb.table("jornadas").select("id, fecha, equipo").range(k, k + 999).execute()
        for j in res.data:
            jmap[(j["fecha"], j["equipo"])] = j["id"]

    for v in visitas:
        v["jornada_id"] = jmap[v.pop("jornada")]
    chunked(visitas, "visitas")

    print("Seed completado.")


if __name__ == "__main__":
    for var in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not os.environ.get(var):
            sys.exit(f"Falta la variable de entorno {var}")
    main()
