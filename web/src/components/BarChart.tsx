import { useState } from "react";

export interface Punto { fecha: string; equipo: string; pacientes: number; }

// Barras SVG sin dependencias: serie única (el título la nombra, sin
// leyenda), marcas delgadas con separación, grid recesivo y tooltip hover.
export default function BarChart({ data }: { data: Punto[] }) {
  const [tip, setTip] = useState<{ x: number; y: number; p: Punto } | null>(null);
  if (data.length === 0) return <p style={{ color: "var(--tinta-2)" }}>Sin datos todavía.</p>;

  const W = 900, H = 240, M = { top: 12, right: 8, bottom: 26, left: 36 };
  const max = Math.max(...data.map((d) => d.pacientes));
  const yMax = Math.ceil(max / 20) * 20 || 20;
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
  const paso = iw / data.length;
  const ancho = Math.max(2, paso - 2); // gap de 2px entre barras
  const y = (v: number) => M.top + ih - (v / yMax) * ih;
  const ticks = [0, yMax / 2, yMax];

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} role="img"
        aria-label="Visitas por jornada">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="var(--linea)" strokeWidth={1} />
            <text x={M.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--tinta-3)">{t}</text>
          </g>
        ))}
        {data.map((d, i) => (
          <rect
            key={d.fecha + d.equipo}
            x={M.left + i * paso + 1}
            y={y(d.pacientes)}
            width={ancho}
            height={Math.max(1, M.top + ih - y(d.pacientes))}
            rx={Math.min(3, ancho / 2)}
            fill="var(--acento)"
            opacity={tip && tip.p !== d ? 0.55 : 1}
            onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, p: d })}
            onMouseLeave={() => setTip(null)}
          />
        ))}
        <line x1={M.left} x2={W - M.right} y1={M.top + ih} y2={M.top + ih} stroke="var(--tinta-3)" strokeWidth={1} />
        <text x={M.left} y={H - 6} fontSize={11} fill="var(--tinta-3)">{data[0].fecha}</text>
        <text x={W - M.right} y={H - 6} fontSize={11} fill="var(--tinta-3)" textAnchor="end">
          {data[data.length - 1].fecha}
        </text>
      </svg>
      {tip && (
        <div className="chart-tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.p.fecha} · Equipo {tip.p.equipo}: <strong>{tip.p.pacientes}</strong> visitas
        </div>
      )}
    </div>
  );
}
