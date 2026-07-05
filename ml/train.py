"""Entrenamiento batch (GitHub Actions, cron semanal).

Lee v_demanda_por_turno, entrena HistGradientBoostingRegressor con
split TEMPORAL 80/20, sube el modelo al bucket privado `modelos` y
registra las metricas en la tabla `modelos`.
"""

import io
import os
import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from supabase import create_client

from feriados import es_feriado

EQUIPO_MAP = {"A": 0, "B": 1, "C": 2, "D": 3}
FEATURES = ["dia_semana", "mes", "semana_iso", "feriado", "equipo_cod"]
BUCKET = "modelos"
MODEL_PATH = "modelo-latest.joblib"


def construir_features(df: pd.DataFrame) -> pd.DataFrame:
    f = pd.to_datetime(df["fecha"]).dt.date  # ponytail: parsea string o datetime, sin adivinar dtype
    df = df.assign(
        dia_semana=[d.weekday() for d in f],
        mes=[d.month for d in f],
        semana_iso=[d.isocalendar()[1] for d in f],
        feriado=[es_feriado(d) for d in f],
        equipo_cod=df["equipo"].map(EQUIPO_MAP),
    )
    return df


def main():
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    rows, k = [], 0
    while True:
        res = sb.table("v_demanda_por_turno").select("*").order("fecha").range(k, k + 999).execute()
        rows += res.data
        if len(res.data) < 1000:
            break
        k += 1000
    if len(rows) < 50:
        sys.exit(f"Muy pocas filas para entrenar ({len(rows)}); corre ml/seed.py primero")

    df = construir_features(pd.DataFrame(rows).sort_values("fecha").reset_index(drop=True))
    X, y = df[FEATURES], df["pacientes"]

    # Split temporal 80/20 — sin shuffle, es serie temporal
    corte = int(len(df) * 0.8)
    modelo = HistGradientBoostingRegressor(random_state=42)
    modelo.fit(X.iloc[:corte], y.iloc[:corte])

    pred = modelo.predict(X.iloc[corte:])
    y_test = y.iloc[corte:]
    mae = float(mean_absolute_error(y_test, pred))
    rmse = float(np.sqrt(mean_squared_error(y_test, pred)))
    r2 = float(r2_score(y_test, pred))

    # Reentrena con TODO el dato para el modelo publicado
    modelo.fit(X, y)

    buf = io.BytesIO()
    joblib.dump({"model": modelo, "features": FEATURES, "equipo_map": EQUIPO_MAP,
                 "metrics": {"mae": mae, "rmse": rmse, "r2": r2}}, buf)

    sb.storage.from_(BUCKET).upload(
        MODEL_PATH, buf.getvalue(),
        file_options={"content-type": "application/octet-stream", "upsert": "true"},
    )
    sb.table("modelos").insert({
        "mae": mae, "rmse": rmse, "r2": r2,
        "n_filas": len(df), "storage_path": f"{BUCKET}/{MODEL_PATH}",
    }).execute()

    print(f"Filas: {len(df)} | MAE: {mae:.2f} | RMSE: {rmse:.2f} | R2: {r2:.3f}")
    print(f"Modelo subido a {BUCKET}/{MODEL_PATH}")


if __name__ == "__main__":
    main()
