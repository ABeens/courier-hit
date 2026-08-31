/**
 * Catalogo de operaciones de la API publica: la UNICA descripcion de que hace
 * cada endpoint, que parametros acepta y que devuelve.
 *
 * Existe para que no haya dos verdades. De aqui salen las dos caras de la
 * documentacion:
 *
 *   - el documento OpenAPI que sirve la API en `/api/v1/openapi.json`
 *     (`buildPublicApiSpec`), que es lo que un integrador mete en Postman o en
 *     un generador de clientes;
 *   - la pagina de documentacion del sitio (`/desarrolladores`), que es lo que
 *     lee una persona.
 *
 * Escribirlo dos veces garantiza que un dia digan cosas distintas, y la
 * documentacion equivocada de una API es peor que no tenerla: manda a integrar
 * contra algo que no existe.
 */
import { PUBLIC_API_VERSION } from './dto';

/** De donde sale un parametro. */
export type ApiParamIn = 'path' | 'query' | 'body';

export interface ApiParam {
  name: string;
  /** Tipo tal como se le explica a una persona: `string`, `number`, `ISO 8601`. */
  type: string;
  in: ApiParamIn;
  required: boolean;
  description: string;
  example?: string;
}

/** Un desenlace de error documentado: el codigo estable y cuando aparece. */
export interface ApiErrorCase {
  status: number;
  code: string;
  when: string;
}

export interface ApiOperation {
  /** `operationId` de OpenAPI y ancla de la pagina de documentacion. */
  id: string;
  method: 'GET' | 'POST';
  /** Ruta relativa a la raiz de la API, con `{parametros}` de OpenAPI. */
  path: string;
  summary: string;
  description: string;
  params: readonly ApiParam[];
  /** Cuerpo de ejemplo (JSON ya formateado); solo en las operaciones con cuerpo. */
  requestExample?: string;
  /** Respuesta de ejemplo (JSON ya formateado). */
  responseExample: string;
  /** Codigo HTTP de la respuesta correcta. 201 en las altas. */
  successStatus: number;
  /** Errores PROPIOS de la operacion; los comunes van en `PUBLIC_API_COMMON_ERRORS`. */
  errors: readonly ApiErrorCase[];
}

/**
 * Errores que puede devolver CUALQUIER operacion. Se documentan una vez y no en
 * cada endpoint: repetirlos en las cinco hace que nadie los lea.
 */
export const PUBLIC_API_COMMON_ERRORS: readonly ApiErrorCase[] = [
  {
    status: 401,
    code: 'API_KEY_MISSING',
    when: 'La peticion no lleva la cabecera `Authorization: Bearer` ni `X-API-Key`.',
  },
  {
    status: 401,
    code: 'API_KEY_INVALID',
    when: 'La llave no existe, esta mal formada o es de otro entorno (una `test` contra produccion).',
  },
  {
    status: 401,
    code: 'API_KEY_REVOKED',
    when: 'La llave fue revocada o la reemplazo una rotacion. Genera una nueva desde el portal.',
  },
  {
    status: 403,
    code: 'ACCOUNT_INACTIVE',
    when: 'La cuenta del casillero esta deshabilitada; sus llaves dejan de servir con ella.',
  },
  {
    status: 429,
    code: 'RATE_LIMITED',
    when: 'Se paso el limite de peticiones. La respuesta trae `Retry-After` con los segundos que esperar.',
  },
  {
    status: 503,
    code: 'PUBLIC_API_DISABLED',
    when: 'La API publica esta apagada por mantenimiento.',
  },
];

const PACKAGE_EXAMPLE = `{
  "code": "HSX-1042",
  "tracking": "TBA305512345678",
  "description": "Audifonos inalambricos",
  "state": "en_transito_costa_rica",
  "stateLabel": "En Tránsito a Costa Rica",
  "store": "AMAZON",
  "carrier": "AMAZON LOGISTICS",
  "hawb": "LES48450141",
  "weightKg": 1.4,
  "declaredValueUsd": 89.99,
  "invoiceTotalCrc": null,
  "invoiceTotalUsd": null,
  "pendingCrc": 0,
  "settled": false,
  "createdAt": "2026-08-14T18:22:05.331Z",
  "updatedAt": "2026-08-20T13:04:41.902Z"
}`;

/** Indenta un bloque JSON ya formateado para incrustarlo dentro de otro. */
function indent(block: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return block
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}

export const PUBLIC_API_OPERATIONS: readonly ApiOperation[] = [
  {
    id: 'getClient',
    method: 'GET',
    path: '/v1/client',
    summary: 'Consulta del cliente',
    description:
      'Devuelve la cuenta a la que pertenece la llave. Es la forma mas barata de comprobar que ' +
      'una llave funciona y de saber contra que casillero quedo integrado un sistema.',
    params: [],
    successStatus: 200,
    responseExample: `{
  "clientCode": "HS-1042",
  "name": "María Rodríguez",
  "email": "maria@ejemplo.com",
  "memberSince": "2026-03-11"
}`,
    errors: [],
  },
  {
    id: 'getLocker',
    method: 'GET',
    path: '/v1/locker',
    summary: 'Consulta de casillero',
    description:
      'La direccion de Miami del cliente, linea a linea y lista para pegar en el checkout de una ' +
      'tienda. La direccion fisica es la misma para todos los clientes: lo que identifica el ' +
      'paquete es el codigo de casillero que va junto al nombre, y por eso la respuesta lo trae ' +
      'ya incrustado en las lineas.',
    params: [],
    successStatus: 200,
    responseExample: `{
  "clientCode": "HS-1042",
  "subLocker": "SJO008835S033",
  "lines": [
    { "label": "Nombre", "value": "María Rodríguez HS-1042" },
    { "label": "Dirección", "value": "1350 NW 121 ST Ave" },
    { "label": "Apto / Suite", "value": "Suite 700 SJO 008835" },
    { "label": "Ciudad", "value": "Miami" },
    { "label": "Estado", "value": "Florida" },
    { "label": "Código postal", "value": "33182" },
    { "label": "País", "value": "Estados Unidos" }
  ]
}`,
    errors: [],
  },
  {
    id: 'listPackages',
    method: 'GET',
    path: '/v1/packages',
    summary: 'Consulta de paquetes (por estado o por cliente)',
    description:
      'Los paquetes del cliente de la llave, del mas reciente al mas antiguo. Sin filtros los ' +
      'devuelve todos: esa es la consulta "por cliente". Con `state` devuelve solo los de ese ' +
      'estado, que es la consulta "por estado" (por ejemplo, los prealertados).',
    params: [
      {
        name: 'state',
        in: 'query',
        type: 'string',
        required: false,
        description:
          'Clave del estado. Los de un paquete son `prealertado`, `recibido_bodega_miami`, ' +
          '`preparando_envio`, `en_transito_costa_rica`, `en_aduanas`, `facturacion_en_proceso`, ' +
          '`en_bodega_pendiente_pago`, `en_ruta_entrega`, `entregado` y `devuelto_bodega`.',
        example: 'prealertado',
      },
      {
        name: 'tracking',
        in: 'query',
        type: 'string',
        required: false,
        description: 'Coincidencia exacta por numero de guia. No es una busqueda parcial.',
        example: 'TBA305512345678',
      },
      {
        name: 'clientCode',
        in: 'query',
        type: 'string',
        required: false,
        description:
          'Casillero contra el que se pregunta. Sirve para que un sistema que maneja varias ' +
          'llaves afirme con cual esta trabajando: si no es el de la llave, responde 403 en vez ' +
          'de una lista vacia.',
        example: 'HS-1042',
      },
      {
        name: 'from',
        in: 'query',
        type: 'ISO 8601',
        required: false,
        description: 'Inicio del rango por fecha de ingreso, inclusive. En UTC.',
        example: '2026-08-01T00:00:00Z',
      },
      {
        name: 'to',
        in: 'query',
        type: 'ISO 8601',
        required: false,
        description: 'Fin del rango por fecha de ingreso, exclusivo. En UTC.',
        example: '2026-09-01T00:00:00Z',
      },
      {
        name: 'page',
        in: 'query',
        type: 'number',
        required: false,
        description: 'Pagina, empezando en 1. Por defecto 1.',
        example: '1',
      },
      {
        name: 'pageSize',
        in: 'query',
        type: 'number',
        required: false,
        description: 'Filas por pagina. Por defecto 50, maximo 100.',
        example: '50',
      },
    ],
    successStatus: 200,
    responseExample: `{
  "items": [
    ${indent(PACKAGE_EXAMPLE, 4)}
  ],
  "total": 37,
  "page": 1,
  "pageSize": 50
}`,
    errors: [
      {
        status: 403,
        code: 'CLIENT_MISMATCH',
        when: 'El `clientCode` de la consulta no es el casillero al que pertenece la llave.',
      },
    ],
  },
  {
    id: 'getPackageByTracking',
    method: 'GET',
    path: '/v1/packages/{tracking}',
    summary: 'Consulta de paquete por numero de tracking',
    description:
      'Un paquete concreto por su guia. Si el mismo tracking se uso mas de una vez (una ' +
      'devolucion y una recompra, por ejemplo) devuelve el mas reciente. Responde 404 tanto si ' +
      'el tracking no existe como si es de otro casillero: la API publica nunca confirma la ' +
      'existencia de un paquete ajeno.',
    params: [
      {
        name: 'tracking',
        in: 'path',
        type: 'string',
        required: true,
        description: 'Numero de guia del transportista. No distingue mayusculas.',
        example: 'TBA305512345678',
      },
    ],
    successStatus: 200,
    responseExample: PACKAGE_EXAMPLE,
    errors: [
      {
        status: 404,
        code: 'PACKAGE_NOT_FOUND',
        when: 'No hay ningun paquete de este casillero con esa guia.',
      },
    ],
  },
  {
    id: 'createPrealert',
    method: 'POST',
    path: '/v1/prealerts',
    summary: 'Prealerta de paquete',
    description:
      'Registra una compra que viene en camino a la bodega de Miami. Es el mismo acto que la ' +
      'prealerta del portal: el paquete nace en estado `prealertado` a nombre del cliente de la ' +
      'llave y, si la integracion con la bodega esta encendida, se le anuncia tambien a ella. ' +
      'Un tracking que ya tiene un paquete en curso se rechaza con 409 en vez de duplicarse.',
    params: [
      {
        name: 'tracking',
        in: 'body',
        type: 'string',
        required: true,
        description: 'Guia del transportista. Entre 3 y 40 caracteres: letras, numeros y guiones.',
        example: 'TBA305512345678',
      },
      {
        name: 'description',
        in: 'body',
        type: 'string',
        required: true,
        description: 'Que viene dentro. Hasta 200 caracteres.',
        example: 'Audifonos inalambricos',
      },
      {
        name: 'store',
        in: 'body',
        type: 'string',
        required: true,
        description:
          'Tienda donde se compro. Valores: `AMAZON`, `EBAY`, `OLD NAVY`, `SHEIN`, `TEMU`, ' +
          '`WALMART`, `HOME DEPOT`, `PANDORA`, `VICTORIA SECRET`, `SARAH`, `H&M`, `OTRO`.',
        example: 'AMAZON',
      },
      {
        name: 'carrier',
        in: 'body',
        type: 'string',
        required: true,
        description:
          'Transportista que lo lleva a Miami. Valores: `AMAZON LOGISTICS`, `USPS`, `FEDEX`, ' +
          '`UPS`, `DHL`, `YUN EXPRESS`, `GOFO`, `EMS`, `OTRO`.',
        example: 'AMAZON LOGISTICS',
      },
      {
        name: 'declaredValueUsd',
        in: 'body',
        type: 'number',
        required: true,
        description: 'Valor comercial de la compra, en dolares. Mayor que cero.',
        example: '89.99',
      },
    ],
    successStatus: 201,
    requestExample: `{
  "tracking": "TBA305512345678",
  "description": "Audifonos inalambricos",
  "store": "AMAZON",
  "carrier": "AMAZON LOGISTICS",
  "declaredValueUsd": 89.99
}`,
    responseExample: `{
  "code": "HSX-1042",
  "tracking": "TBA305512345678",
  "description": "Audifonos inalambricos",
  "state": "prealertado",
  "stateLabel": "Prealertado",
  "store": "AMAZON",
  "carrier": "AMAZON LOGISTICS",
  "hawb": null,
  "weightKg": null,
  "declaredValueUsd": 89.99,
  "invoiceTotalCrc": null,
  "invoiceTotalUsd": null,
  "pendingCrc": 0,
  "settled": false,
  "createdAt": "2026-08-30T15:11:02.774Z",
  "updatedAt": "2026-08-30T15:11:02.774Z"
}`,
    errors: [
      {
        status: 400,
        code: 'VALIDATION_ERROR',
        when: 'Falta un campo obligatorio o alguno no cumple el formato. El mensaje dice cual.',
      },
      {
        status: 409,
        code: 'SHIPMENT_TRACKING_IN_USE',
        when: 'Ya existe un paquete en curso con esa misma guia.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Ejemplo de peticion
// ---------------------------------------------------------------------------

/**
 * El `curl` de una operacion, listo para pegar en una terminal.
 *
 * Vive aqui y no en la pagina que lo pinta porque ya son dos las que lo
 * necesitan (la documentacion publica y el modal "Como usar la API" del
 * portal), y dos generadores acaban ensenando dos comandos distintos para la
 * misma operacion.
 *
 * `baseUrl` es la raiz completa de la API (`https://…/api/v1`): igual que en el
 * documento OpenAPI, se pasa desde fuera para que el ejemplo funcione tal cual
 * en el entorno desde el que se lee.
 */
export function buildPublicApiCurl(op: ApiOperation, baseUrl: string): string {
  const query = op.params
    .filter((p) => p.in === 'query' && p.example)
    .slice(0, 2)
    .map((p) => `${p.name}=${encodeURIComponent(p.example!)}`)
    .join('&');

  // El catalogo guarda la ruta con su version (`/v1/...`) porque asi la nombra
  // OpenAPI; `baseUrl` ya la trae, asi que aqui sobra.
  let path = op.path.replace(`/${PUBLIC_API_VERSION}`, '');
  for (const param of op.params) {
    if (param.in === 'path' && param.example) {
      path = path.replace(`{${param.name}}`, param.example);
    }
  }

  const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
  const lines = [`curl "${url}"`, `  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}"`];
  if (op.requestExample) {
    lines.splice(1, 0, `  -X POST`);
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${op.requestExample.replace(/\n\s*/g, ' ')}'`);
  }
  return lines.join(' \\n');
}

/**
 * Una llave de ejemplo, con la forma exacta que emite el sistema: prefijo de
 * entorno, identificador publico y secreto. Se ensena entera una vez para que
 * quien la esta copiando reconozca lo que tiene que pegar (y note si se dejo la
 * mitad por el camino), pero NO se usa en los ejemplos: ahi va el hueco.
 */
export const API_KEY_SAMPLE = 'hsk_live_kq7m3xb9tzr4dph2_a8fj2mnqv5wc7xtz3rkd9hp6bs4gy2fm';

/**
 * Lo que ocupa el lugar de la llave en TODOS los ejemplos.
 *
 * Antes ahi iba una variable de entorno: buena practica y mal ejemplo, porque
 * quien copiaba el comando la mandaba vacia y recibia un 401 sin entender por
 * que. Un hueco que se lee "tu llave" no se copia por error, y conserva el
 * prefijo para que se vea donde empieza la llave y donde acaba.
 */
export const API_KEY_PLACEHOLDER = 'hsk_live_TU_LLAVE';

/** Un ejemplo de "asi se manda la llave", en el lenguaje de quien lo lee. */
export interface ApiAuthSnippet {
  id: string;
  /** Como se llama en la pestaña o el encabezado que lo presenta. */
  label: string;
  code: string;
}

/**
 * Los ejemplos de autenticacion: la MISMA peticion (`GET /client`, la mas barata
 * y la que sirve de prueba de vida) en las tres formas con las que se integra
 * casi todo el mundo aqui: la terminal, un backend en JavaScript y PowerShell,
 * que es lo que tienen a mano los ERP en Windows.
 *
 * Van juntos y en el mismo sitio que el resto del catalogo porque la pregunta
 * que responden ("¿donde exactamente pongo la llave?") es la unica que hay que
 * contestar dos veces: en el portal, al crearla, y en la pagina publica, al
 * evaluar la integracion.
 */
export function buildPublicApiAuthSnippets(baseUrl: string): readonly ApiAuthSnippet[] {
  const url = `${baseUrl}/client`;
  return [
    {
      id: 'curl',
      label: 'curl',
      code: [`curl "${url}" \\`, `  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}"`].join('\n'),
    },
    {
      id: 'javascript',
      label: 'JavaScript',
      code: [
        `const res = await fetch('${url}', {`,
        `  headers: { Authorization: 'Bearer ${API_KEY_PLACEHOLDER}' },`,
        '});',
        'const data = await res.json();',
        '// Un error trae { error: { code, message } }; el code es la parte estable.',
        'if (!res.ok) throw new Error(data.error.code);',
        'console.log(data.code); // tu casillero, p. ej. SJO008835',
      ].join('\n'),
    },
    {
      id: 'powershell',
      label: 'PowerShell',
      code: [
        `$headers = @{ Authorization = 'Bearer ${API_KEY_PLACEHOLDER}' }`,
        `Invoke-RestMethod -Uri '${url}' -Headers $headers`,
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

/** Tipo OpenAPI equivalente al tipo "para personas" de `ApiParam.type`. */
function schemaFor(param: ApiParam): Record<string, unknown> {
  if (param.type === 'number') return { type: 'number' };
  if (param.type === 'ISO 8601') return { type: 'string', format: 'date-time' };
  return { type: 'string' };
}

/**
 * Documento OpenAPI 3.1 de la API publica, derivado del catalogo de arriba.
 *
 * `serverUrl` se pasa desde fuera y no se fija aqui porque el mismo codigo sirve
 * al entorno de desarrollo (`http://localhost:3001/api`) y a produccion: un
 * documento con la URL equivocada manda a integrar contra el sitio que no es.
 */
export function buildPublicApiSpec(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of PUBLIC_API_OPERATIONS) {
    const bodyParams = op.params.filter((p) => p.in === 'body');
    const operation: Record<string, unknown> = {
      operationId: op.id,
      summary: op.summary,
      description: op.description,
      parameters: op.params
        .filter((p) => p.in !== 'body')
        .map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required,
          description: p.description,
          schema: schemaFor(p),
          ...(p.example ? { example: p.example } : {}),
        })),
      responses: {
        [String(op.successStatus)]: {
          description: 'Respuesta correcta.',
          content: { 'application/json': { example: JSON.parse(op.responseExample) } },
        },
        ...Object.fromEntries(
          [...op.errors, ...PUBLIC_API_COMMON_ERRORS].map((e) => [
            String(e.status),
            {
              description: `${e.code} — ${e.when}`,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          ]),
        ),
      },
    };

    if (bodyParams.length > 0) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: bodyParams.filter((p) => p.required).map((p) => p.name),
              properties: Object.fromEntries(
                bodyParams.map((p) => [p.name, { ...schemaFor(p), description: p.description }]),
              ),
            },
            ...(op.requestExample ? { example: JSON.parse(op.requestExample) } : {}),
          },
        },
      };
    }

    // El prefijo `/v1` ya va en `servers[].url`: repetirlo aqui daria `/v1/v1/...`
    // en cualquier cliente generado a partir del documento.
    const path = op.path.replace('/v1', '');
    paths[path] ??= {};
    (paths[path] as Record<string, unknown>)[op.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'API de HS Global Services',
      version: '1.0.0',
      description:
        'API de integracion para clientes de HS Global Services: consulta de casillero, consulta ' +
        'de paquetes y prealerta. Se autentica con una llave de API que el cliente genera y rota ' +
        'desde su portal.',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Cabecera `Authorization: Bearer hsk_live_...`.',
        },
        apiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Alternativa para clientes que no pueden fijar la cabecera Authorization.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', description: 'Codigo estable, en MAYUSCULAS.' },
                message: { type: 'string', description: 'Texto explicativo en español.' },
              },
            },
          },
        },
      },
    },
  };
}
