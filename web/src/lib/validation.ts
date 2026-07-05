import { z } from "zod";

export const equipoSchema = z.enum(["A", "B", "C", "D"]);
export const tipoAtencionSchema = z.enum(["consulta", "emergencia", "control", "otro"]);

export const pacienteNuevoSchema = z.object({
  nombres: z.string().trim().min(2, "Nombres: mínimo 2 caracteres").max(120),
  apellidos: z.string().trim().min(2, "Apellidos: mínimo 2 caracteres").max(120),
  // DPI/CUI opcional: puede quedar vacío y no es único
  documento: z
    .string()
    .trim()
    .regex(/^\d{13}$/, "El DPI/CUI debe tener 13 dígitos")
    .or(z.literal("")),
  equipo: equipoSchema,
  tipo_atencion: tipoAtencionSchema,
});

export const visitaSchema = z.object({
  paciente_id: z.string().uuid(),
  equipo: equipoSchema,
  tipo_atencion: tipoAtencionSchema,
});

export type PacienteNuevo = z.infer<typeof pacienteNuevoSchema>;

export interface PacienteEncontrado {
  id: string;
  correlativo: number;
  nombres: string;
  apellidos: string;
}
