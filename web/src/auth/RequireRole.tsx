import { Navigate } from "react-router-dom";
import { type Rol, useAuth } from "./AuthProvider";

// Guarda de ruta: exige sesión y, opcionalmente, uno de los roles dados.
export function RequireRole({ roles, children }: { roles?: Rol[]; children: React.ReactNode }) {
  const { session, rol, cargando, needsMfa } = useAuth();

  if (cargando) return null;
  if (!session) return <Navigate to="/login" replace />;
  // MFA pendiente: no se accede a nada hasta completar el segundo factor
  if (needsMfa) return <Navigate to="/login" replace />;
  if (roles && (!rol || !roles.includes(rol))) {
    return (
      <div className="contenido">
        <div className="aviso error">No tiene permisos para ver esta sección (rol: {rol ?? "sin rol"}).</div>
      </div>
    );
  }
  return <>{children}</>;
}
