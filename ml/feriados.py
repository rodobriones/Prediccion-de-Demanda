"""Feriados de Guatemala (fijos). Helper compartido por seed y train.
Nota: api/predict.py duplica esta lista porque la funcion de Vercel
se despliega aislada del paquete ml/."""

from datetime import date

# (mes, dia)
FERIADOS_GT = {
    (1, 1),   # Año Nuevo
    (5, 1),   # Día del Trabajo
    (6, 30),  # Día del Ejército
    (9, 15),  # Independencia
    (10, 20), # Revolución de 1944
    (11, 1),  # Todos los Santos
    (12, 24), # Nochebuena
    (12, 25), # Navidad
    (12, 31), # Fin de año
}
# Semana Santa varía; para el proyecto académico basta una lista fija
# de jueves/viernes santo de los años del dataset.
FERIADOS_MOVILES = {
    date(2025, 4, 17), date(2025, 4, 18),
    date(2026, 4, 2), date(2026, 4, 3),
}


def es_feriado(d: date) -> int:
    return int((d.month, d.day) in FERIADOS_GT or d in FERIADOS_MOVILES)
