/**
 * Que formatos acepta cada punto de subida del sistema.
 *
 * Vive en el dominio compartido y no en la API porque las dos orillas tienen que
 * mirar la MISMA tabla: el `accept` del input y el aviso que ve el usuario salen
 * de aqui, y el borde del servidor rechaza con esta misma lista. Separarlas
 * significaba que el navegador dejara elegir un archivo que la API despues
 * rechaza (o al reves), que es el bug que esta tabla existe para evitar.
 *
 * Cada catalogo mapea MIME -> extension con la que se guarda. La extension es lo
 * unico del archivo original que sobrevive —la clave del almacen es opaca, ver
 * `core/storage.ts`— y es de donde se deduce el content-type al servirlo de
 * vuelta.
 */

/** Un catalogo de formatos: que se acepta, como se ofrece y como se nombra. */
export interface AttachmentKind {
  /** MIME declarado -> extension con la que se guarda. */
  readonly extensions: Readonly<Record<string, string>>;
  /** Valor del atributo `accept` de un `<input type="file">`. */
  readonly accept: string;
  /** Como se nombran estos formatos en un mensaje al usuario. */
  readonly label: string;
}

/**
 * Valor de `accept` a partir del catalogo: extensiones Y MIMEs.
 *
 * Las dos formas, porque no basta con una: Windows deduce el MIME de la
 * extension y para un .docx sin Office instalado manda cadena vacia, con lo que
 * un filtro solo por MIME esconderia el archivo del selector.
 */
function acceptFrom(extensions: Readonly<Record<string, string>>): string {
  const exts = [...new Set(Object.values(extensions))].map((e) => `.${e}`);
  return [...exts, ...Object.keys(extensions)].join(',');
}

/** Si un MIME es de imagen. Sirve para dar el motivo exacto del rechazo. */
export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

/**
 * PRUEBA de algo que ocurrio: el comprobante de un deposito o la foto de una
 * entrega. Aqui la imagen es el caso normal (una foto del recibo o del paquete
 * en la puerta), asi que se acepta junto al PDF.
 */
export const PROOF_ATTACHMENT: AttachmentKind = {
  extensions: {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  },
  accept: 'image/*,application/pdf',
  label: 'imágenes (JPG, PNG, WEBP) o PDF',
};

/**
 * DOCUMENTO que acompaña a un tramite (la factura de la compra que se prealerta,
 * por ejemplo).
 *
 * Aqui la imagen se rechaza a proposito, y no por capricho de formato: lo que se
 * adjunta es un documento que alguien tiene que leer, cotejar contra la
 * declaracion y, si hace falta, presentar. Una foto de pantalla no se puede
 * seleccionar, ni buscar, ni imprimir con la misma garantia, y es justo lo que
 * un cliente adjunta si se le deja.
 */
const DOCUMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  // Word: el binario viejo (.doc) y el de Office moderno (.docx).
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  // Hoja de calculo: muchas facturas de proveedor llegan asi.
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  // OpenDocument (LibreOffice), texto y hoja de calculo.
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  // Formatos de texto enriquecido y plano. Dos MIMEs para el RTF: cada sistema
  // declara el suyo y los dos son el mismo archivo.
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'text/plain': 'txt',
};

export const DOCUMENT_ATTACHMENT: AttachmentKind = {
  extensions: DOCUMENT_EXTENSIONS,
  accept: acceptFrom(DOCUMENT_EXTENSIONS),
  label: 'documentos (PDF, Word, Excel, ODT, RTF o TXT)',
};

/** Si el catalogo admite alguna imagen (define el mensaje de rechazo). */
function acceptsImages(kind: AttachmentKind): boolean {
  return Object.keys(kind.extensions).some(isImageMime);
}

/** MIMEs que no dicen nada: hay que mirar el nombre para saber que es. */
const OPAQUE_MIMES = new Set(['', 'application/octet-stream']);

/** Extension del nombre de archivo, en minusculas y sin punto. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * Extension con la que se guardaria el archivo, o `null` si el formato no entra
 * en el catalogo. Es la decision unica de "esto se acepta" y de "con que nombre
 * se guarda": las dos respuestas salen de la misma tabla.
 *
 * Normalmente decide el MIME. Cuando el sistema operativo no sabe declararlo
 * —Windows manda cadena vacia para un .docx si no hay Office instalado, y algun
 * navegador manda `application/octet-stream`— se cae al nombre del archivo, pero
 * SOLO en ese caso: un MIME que si dice algo manda siempre, asi que renombrar
 * una foto a `.pdf` no la cuela (llega como `image/jpeg` y se rechaza ahi).
 *
 * El nombre es texto del usuario, pero de el solo sale una BUSQUEDA en la tabla:
 * lo que se guarda es el valor del catalogo, nunca la cadena recibida.
 */
export function attachmentExtension(
  kind: AttachmentKind,
  mime: string,
  filename = '',
): string | null {
  const byMime = kind.extensions[mime];
  if (byMime) return byMime;

  if (OPAQUE_MIMES.has(mime)) {
    const ext = extensionOf(filename);
    if (ext && Object.values(kind.extensions).includes(ext)) return ext;
  }
  return null;
}

/**
 * Motivo por el que un archivo NO se acepta, o `null` si el formato esta bien.
 *
 * El caso de la imagen tiene mensaje propio porque es el error frecuente y el
 * generico no lo explica: quien sube la foto de una factura cree estar subiendo
 * la factura, y "solo se aceptan documentos" no le dice que su archivo ES el
 * problema.
 *
 * Es la MISMA comprobacion que hace el servidor, con los mismos datos (lo que
 * declara el navegador). No es una garantia criptografica del contenido —nadie
 * firma un multipart—, pero si la frontera consistente entre las dos orillas.
 */
export function attachmentRejection(
  kind: AttachmentKind,
  mime: string,
  filename = '',
): string | null {
  if (attachmentExtension(kind, mime, filename)) return null;
  if (isImageMime(mime) && !acceptsImages(kind)) {
    return `No se aceptan imágenes; solo ${kind.label}.`;
  }
  return `Solo se aceptan ${kind.label}.`;
}
