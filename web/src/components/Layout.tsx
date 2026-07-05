import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

const enlaces = [
  { a: "/admision", texto: "Admisión", roles: ["digitador", "admin"] },
  { a: "/consulta", texto: "Consulta", roles: ["digitador", "estadistica", "admin"] },
  { a: "/dashboard", texto: "Dashboard", roles: ["estadistica", "admin"] },
  { a: "/seguridad", texto: "Seguridad", roles: ["estadistica", "admin"] },
];

export default function Layout() {
  const { session, rol, salir } = useAuth();

  return (
    <>
      <header className="topbar">
        <div className="brand">CAP · <em>Admisión</em></div>
        <nav>
          {enlaces
            .filter((e) => rol && e.roles.includes(rol))
            .map((e) => (
              <NavLink key={e.a} to={e.a} className={({ isActive }) => (isActive ? "activo" : "")}>
                {e.texto}
              </NavLink>
            ))}
        </nav>
        <div className="usuario">
          <span>{session?.user.email}</span>
          <span className="chip">{rol}</span>
          <button className="secundario" onClick={salir}>Salir</button>
        </div>
      </header>
      <main className="contenido">
        <Outlet />
      </main>
    </>
  );
}
