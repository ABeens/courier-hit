/**
 * Cliente HTTP del portal. Habla con apps/api enviando SIEMPRE la cookie de
 * sesion (credentials: include). La seguridad real esta en la API (docs/04):
 * aqui solo consumimos y mostramos errores en el contrato unico {error:{code,message}}.
 */
const BASE = import.meta.env.PUBLIC_API_BASE ?? 'http://localhost:3001';

/**
 * Origen de la API. Se exporta para las descargas y las imagenes, que no pasan
 * por `request` (son `<a href>` y `<img src>` que resuelve el navegador) pero
 * tienen que apuntar al mismo servidor.
 */
export const API_BASE = BASE;

/** Error tipado que preserva `code` (estable) para ramificar en la UI. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = data?.error ?? { code: 'UNKNOWN', message: 'Ocurrió un error inesperado.' };
    throw new ApiError(res.status, err.code, err.message);
  }
  return data as T;
}

/**
 * Subida de un archivo (multipart). No pasa por `request` porque ahi el cuerpo
 * se serializa a JSON y aqui hay que dejar que el navegador arme el multipart
 * con su boundary: fijar `content-type` a mano rompe la peticion.
 *
 * Devuelve lo mismo y falla igual que el resto del cliente (`ApiError` con el
 * `code` estable), que es justo lo que no daba el `fetch` suelto que se repetia
 * en cada modal con archivo.
 */
async function upload<T>(path: string, file: File, field = 'file'): Promise<T> {
  const form = new FormData();
  form.set(field, file);

  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = data?.error ?? { code: 'UNKNOWN', message: 'No se pudo subir el archivo.' };
    throw new ApiError(res.status, err.code, err.message);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  upload,
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
