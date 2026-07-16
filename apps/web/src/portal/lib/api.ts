/**
 * Cliente HTTP del portal. Habla con apps/api enviando SIEMPRE la cookie de
 * sesion (credentials: include). La seguridad real esta en la API (docs/04):
 * aqui solo consumimos y mostramos errores en el contrato unico {error:{code,message}}.
 */
const BASE = import.meta.env.PUBLIC_API_BASE ?? 'http://localhost:3001';

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

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
