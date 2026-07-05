import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import MfaSetup from "./auth/MfaSetup";
import { RequireRole } from "./auth/RequireRole";
import Layout from "./components/Layout";
import Admision from "./pages/Admision";
import Consulta from "./pages/Consulta";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";

function Inicio() {
  const { rol } = useAuth();
  return <Navigate to={rol === "estadistica" ? "/dashboard" : "/admision"} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireRole><Layout /></RequireRole>}>
            <Route index element={<Inicio />} />
            <Route path="/admision" element={<RequireRole roles={["digitador", "admin"]}><Admision /></RequireRole>} />
            <Route path="/consulta" element={<Consulta />} />
            <Route path="/dashboard" element={<RequireRole roles={["estadistica", "admin"]}><Dashboard /></RequireRole>} />
            <Route path="/seguridad" element={<RequireRole roles={["estadistica", "admin"]}><MfaSetup /></RequireRole>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
