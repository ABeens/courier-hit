/**
 * Almacen de archivos adjuntos: comprobantes de deposito, fotos de entrega y
 * documentos de tramite.
 *
 * El contrato es deliberadamente pobre —guardar, leer, borrar por CLAVE— para
 * que el driver se pueda cambiar sin tocar a quien lo usa. Hoy escribe en disco
 * local; en AWS sera S3.
 *
 * TODO(12): driver de S3 (bucket privado + URLs firmadas). Solo cambia este
 * archivo: `put`/`get` mantienen su firma y los modulos que suben archivos
 * siguen guardando una clave opaca. Que tipos se aceptan NO es cosa del driver
 * (vive en `@courier/shared`, ver `AttachmentKind`), asi que la validacion de
 * formato sobrevive intacta al cambio.
 *
 * La CLAVE es opaca a proposito (`<carpeta>/<uuid>.<ext>`): no incluye el nombre
 * original ni nada que el usuario controle, asi que no hay forma de armar una
 * ruta que se escape del directorio ni de deducir el archivo de otro cliente.
 * En S3 esa misma cadena es la object key, y su extension sigue siendo de donde
 * se deduce el content-type: nada de esto depende del disco.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  DOCUMENT_ATTACHMENT,
  PROOF_ATTACHMENT,
  attachmentExtension,
  attachmentRejection,
} from '@courier/shared';
import type { AttachmentKind } from '@courier/shared';
import { AppError } from './errors';
import { config } from './config';

/**
 * Extension -> MIME con el que se sirve de vuelta, tomando TODOS los catalogos.
 * La lectura no sabe de que punto de subida vino la clave, solo ve su extension,
 * asi que la tabla inversa tiene que ser una sola y completa.
 */
const MIME_BY_EXTENSION: Record<string, string> = {};
for (const kind of [PROOF_ATTACHMENT, DOCUMENT_ATTACHMENT]) {
  for (const [mime, ext] of Object.entries(kind.extensions)) {
    MIME_BY_EXTENSION[ext] ??= mime;
  }
}

export const StorageErrors = {
  fileRequired: (what: string) => new AppError('FILE_REQUIRED', `Adjunta ${what}.`, 400),
  fileTooLarge: () =>
    new AppError(
      'FILE_TOO_LARGE',
      `El archivo supera el máximo de ${Math.round(config.UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`,
      413,
    ),
  /** El motivo lo redacta el catalogo: es quien sabe que se esperaba ahi. */
  fileTypeNotAllowed: (reason: string) => new AppError('FILE_TYPE_NOT_ALLOWED', reason, 415),
  notFound: () => new AppError('FILE_NOT_FOUND', 'Archivo no encontrado.', 404),
};

/** Raiz del almacen, resuelta una vez. */
const root = resolve(config.UPLOADS_DIR);

/**
 * Ruta absoluta de una clave, verificando que caiga DENTRO de la raiz. Las claves
 * las genera `put`, pero esta comprobacion cubre el dia en que una llegue desde
 * la BD alterada a mano.
 */
function pathFor(key: string): string {
  const full = resolve(join(root, key));
  if (full !== root && !full.startsWith(root + sep)) {
    throw StorageErrors.notFound();
  }
  return full;
}

export const storage = {
  /**
   * Guarda el archivo y devuelve su clave. Valida tamaño y tipo AQUI, en el
   * borde: es el unico punto por el que entra un archivo al sistema.
   *
   * `kind` dice QUE se esperaba en ese punto de subida, porque no todos aceptan
   * lo mismo: una entrega se prueba con una foto y un tramite se documenta con
   * un PDF. Por defecto, el catalogo de prueba (comprobantes y fotos), que es de
   * donde salio este almacen.
   */
  async put(folder: string, file: File, kind: AttachmentKind = PROOF_ATTACHMENT): Promise<string> {
    if (file.size === 0) throw StorageErrors.fileRequired('un archivo');
    if (file.size > config.UPLOAD_MAX_BYTES) throw StorageErrors.fileTooLarge();

    const ext = attachmentExtension(kind, file.type, file.name);
    if (!ext) {
      // Sin extension no hay formato aceptable, asi que el motivo existe siempre;
      // el `??` es solo para no depender de esa correlacion desde aqui.
      const reason = attachmentRejection(kind, file.type, file.name);
      throw StorageErrors.fileTypeNotAllowed(reason ?? `Solo se aceptan ${kind.label}.`);
    }

    const key = `${folder}/${randomUUID()}.${ext}`;
    const full = pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, Buffer.from(await file.arrayBuffer()));
    return key;
  },

  /**
   * Contenido de un archivo por su clave, con el mime deducido de la extension.
   * Devuelve `ArrayBuffer` y no `Buffer` porque es lo que acepta el cuerpo de una
   * respuesta de Hono; el `Buffer` de Node no encaja en su tipo.
   */
  async get(key: string): Promise<{ body: ArrayBuffer; contentType: string }> {
    const ext = key.split('.').pop() ?? '';
    const contentType = MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
    try {
      const file = await readFile(pathFor(key));
      // `subarray` sobre el buffer subyacente: evita copiar el contenido otra vez
      // solo para cambiar de tipo.
      return {
        body: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
        contentType,
      };
    } catch {
      throw StorageErrors.notFound();
    }
  },

  /** Borra un archivo. Silencioso si ya no existe: borrar es idempotente. */
  async remove(key: string): Promise<void> {
    try {
      await unlink(pathFor(key));
    } catch {
      // ya no estaba; nada que hacer
    }
  },
};
