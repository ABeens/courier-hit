/**
 * Almacen de archivos adjuntos: comprobantes de deposito, fotos de entrega y
 * documentos de tramite.
 *
 * El contrato es deliberadamente pobre (guardar, leer, borrar por CLAVE) para
 * que el driver se pueda cambiar sin tocar a quien lo usa. Hay dos:
 *
 *   - **disco local** (desarrollo): escribe en `UPLOADS_DIR`. Permite operar de
 *     punta a punta sin cuenta de nube.
 *   - **S3** (produccion): bucket privado, elegido con `UPLOADS_BUCKET`.
 *
 * Lo elige el entorno, no el codigo: con `UPLOADS_BUCKET` cargada se usa S3, sin
 * ella el disco. El disco NO sirve en el servidor porque el filesystem del
 * contenedor es efimero: cada despliegue borraria la prueba de un pago y de una
 * entrega (docs/12 §6.2).
 *
 * La CLAVE es opaca a proposito (`<carpeta>/<uuid>.<ext>`): no incluye el nombre
 * original ni nada que el usuario controle, asi que no hay forma de armar una
 * ruta que se escape del directorio ni de deducir el archivo de otro cliente.
 * En S3 esa misma cadena es la object key, y su extension sigue siendo de donde
 * se deduce el content-type: nada de esto depende del disco.
 *
 * Que tipos se aceptan NO es cosa del driver (vive en `@courier/shared`, ver
 * `AttachmentKind`), asi que la validacion de formato es comun a los dos.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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

/**
 * Lo unico que cambia entre disco y S3. Recibe la clave ya generada y validada:
 * el driver no decide nombres ni acepta o rechaza formatos.
 */
type StorageDriver = {
  write(key: string, body: Buffer, contentType: string): Promise<void>;
  read(key: string): Promise<ArrayBuffer>;
  delete(key: string): Promise<void>;
};

/** MIME de una clave, deducido de su extension. Comun a los dos drivers. */
function contentTypeOf(key: string): string {
  const ext = key.split('.').pop() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

// --- Driver de disco local (desarrollo) ---------------------------------------

function localDriver(): StorageDriver {
  /** Raiz del almacen, resuelta una vez. */
  const root = resolve(config.UPLOADS_DIR);

  /**
   * Ruta absoluta de una clave, verificando que caiga DENTRO de la raiz. Las
   * claves las genera `put`, pero esta comprobacion cubre el dia en que una
   * llegue desde la BD alterada a mano.
   */
  const pathFor = (key: string): string => {
    const full = resolve(join(root, key));
    if (full !== root && !full.startsWith(root + sep)) {
      throw StorageErrors.notFound();
    }
    return full;
  };

  return {
    async write(key, body) {
      const full = pathFor(key);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body);
    },
    async read(key) {
      try {
        const file = await readFile(pathFor(key));
        // `slice` sobre el buffer subyacente: evita copiar el contenido otra vez
        // solo para cambiar de tipo.
        return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
      } catch {
        throw StorageErrors.notFound();
      }
    },
    async delete(key) {
      try {
        await unlink(pathFor(key));
      } catch {
        // ya no estaba; nada que hacer
      }
    },
  };
}

// --- Driver de S3 (produccion) -------------------------------------------------

function s3Driver(bucket: string): StorageDriver {
  /**
   * Sin credenciales explicitas: en EC2/ECS el SDK las resuelve del rol de la
   * instancia, que es lo correcto (docs/12 §3.6). La region viene de
   * `AWS_REGION`, obligatoria junto con el bucket (ver `core/config`).
   */
  const client = new S3Client({ region: config.AWS_REGION });

  return {
    async write(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async read(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!result.Body) throw StorageErrors.notFound();
        const bytes = await result.Body.transformToByteArray();
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      } catch {
        // Cualquier fallo de lectura se presenta igual que un archivo ausente:
        // quien pide un adjunto no puede hacer nada distinto con un 500.
        throw StorageErrors.notFound();
      }
    },
    async delete(key) {
      // S3 no falla si la clave no existe; borrar sigue siendo idempotente.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

const driver: StorageDriver = config.UPLOADS_BUCKET
  ? s3Driver(config.UPLOADS_BUCKET)
  : localDriver();

if (!config.UPLOADS_BUCKET) {
  console.warn(
    `[storage] Adjuntos en DISCO LOCAL (${config.UPLOADS_DIR}). Solo para desarrollo: ` +
      'en un contenedor este directorio se pierde en cada despliegue. En AWS define UPLOADS_BUCKET.',
  );
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
    await driver.write(key, Buffer.from(await file.arrayBuffer()), contentTypeOf(key));
    return key;
  },

  /**
   * Contenido de un archivo por su clave, con el mime deducido de la extension.
   * Devuelve `ArrayBuffer` y no `Buffer` porque es lo que acepta el cuerpo de una
   * respuesta de Hono; el `Buffer` de Node no encaja en su tipo.
   */
  async get(key: string): Promise<{ body: ArrayBuffer; contentType: string }> {
    return { body: await driver.read(key), contentType: contentTypeOf(key) };
  },

  /** Borra un archivo. Silencioso si ya no existe: borrar es idempotente. */
  async remove(key: string): Promise<void> {
    await driver.delete(key);
  },
};
