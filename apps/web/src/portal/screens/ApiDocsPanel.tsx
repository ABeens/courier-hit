/**
 * Pestaña "Documentación" de la pantalla API (docs/16 §3): la guía de
 * integración dentro del portal, al lado de las llaves.
 *
 * Existe porque el momento en que alguien necesita la documentación es el mismo
 * en que acaba de crear una llave, y mandarlo al sitio público justo ahí es la
 * forma más segura de que copie el token a medias. Aquí tiene lo que se usa el
 * primer día: la URL base, la cabecera, el `curl` de cada operación y los
 * errores. Lo largo (parámetros de cada campo, ejemplos completos, OpenAPI)
 * sigue viviendo en `/desarrolladores`, a un botón del pie.
 *
 * NADA del contenido se escribe aquí: sale de `PUBLIC_API_OPERATIONS` y
 * `PUBLIC_API_COMMON_ERRORS` de `@courier/shared`, la misma fuente que alimenta
 * la página pública y el documento OpenAPI. Una API con dos descripciones acaba
 * teniendo dos, y la equivocada manda a integrar contra algo que no existe.
 */
import { useState, type ReactNode } from 'react';
import type { ApiOperation } from '@courier/shared';
import {
  API_KEY_HEADER,
  API_KEY_PLACEHOLDER,
  API_KEY_SAMPLE,
  PUBLIC_API_COMMON_ERRORS,
  PUBLIC_API_OPERATIONS,
  PUBLIC_API_PREFIX,
  buildPublicApiAuthSnippets,
  buildPublicApiCurl,
} from '@courier/shared';
import { API_BASE } from '../lib/api';

/**
 * Raíz de la API tal como la ve QUIEN ESTÁ LEYENDO. En producción la API se
 * sirve bajo el mismo host que el portal (`API_BASE` vacío), en desarrollo son
 * dos servidores: pegar un `curl` de esta pestaña tiene que funcionar tal cual en
 * los dos, así que la base se calcula, no se escribe.
 */
const baseUrl = `${API_BASE || (typeof window === 'undefined' ? '' : window.location.origin)}${PUBLIC_API_PREFIX}`;

/**
 * Los textos del catálogo marcan el código entre acentos graves, como en
 * Markdown. La página pública los convierte con `set:html`; aquí no se puede
 * (ni conviene) inyectar HTML, así que se parten y se envuelven a mano.
 */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
  );
}

/** Bloque de código con botón de copiar: casi todo lo de aquí se pega. */
function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Sin portapapeles queda seleccionar y copiar a mano; no hay que avisar. */
    }
  }

  return (
    <div className="api-doc__code">
      <pre>
        <code>{code}</code>
      </pre>
      <button type="button" className="api-doc__copy" onClick={copy}>
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

/**
 * Los tres ejemplos de autenticación, uno visible a la vez. Apilados ocupaban
 * media pantalla y obligaban a saltarse dos que no se van a usar; en pestañas,
 * la pregunta "¿dónde pongo la llave?" se responde con un vistazo al lenguaje
 * propio. El primero es curl porque es el que se prueba antes de escribir código.
 */
function SnippetTabs() {
  const snippets = buildPublicApiAuthSnippets(baseUrl);
  const [active, setActive] = useState(snippets[0]!.id);
  const current = snippets.find((s) => s.id === active) ?? snippets[0]!;

  return (
    <div className="api-doc__snippets">
      <div className="tabs tabs-sm" role="tablist" aria-label="Ejemplos de autenticación">
        {snippets.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === active}
            className={`tab ${s.id === active ? 'is-active' : ''}`}
            onClick={() => setActive(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <CodeBlock code={current.code} />
    </div>
  );
}

/** Tabla de errores: el `code` es lo estable, y es sobre lo que se ramifica. */
function ErrorTable({ cases }: { cases: readonly { status: number; code: string; when: string }[] }) {
  return (
    <table className="api-doc__table">
      <thead>
        <tr>
          <th>HTTP</th>
          <th>Código</th>
          <th>Cuándo</th>
        </tr>
      </thead>
      <tbody>
        {cases.map((e) => (
          <tr key={e.code}>
            <td>
              <code>{e.status}</code>
            </td>
            <td>
              <code>{e.code}</code>
            </td>
            <td>{withCode(e.when)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Una operación, plegada. Van cerradas porque son cinco y quien entra busca una:
 * abrir las cinco de golpe convierte la guía en un muro.
 */
function Operation({ op }: { op: ApiOperation }) {
  return (
    <details className="api-doc__op">
      <summary>
        <span className={`api-doc__verb api-doc__verb--${op.method.toLowerCase()}`}>{op.method}</span>
        <code className="api-doc__path">{op.path.replace('/v1', PUBLIC_API_PREFIX)}</code>
        <span className="api-doc__op-name">{op.summary}</span>
      </summary>

      <div className="api-doc__op-body">
        <p className="api-doc__p">{withCode(op.description)}</p>

        {op.params.length > 0 && (
          <>
            <div className="api-doc__h3">Parámetros</div>
            <table className="api-doc__table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>En</th>
                  <th>Tipo</th>
                </tr>
              </thead>
              <tbody>
                {op.params.map((p) => (
                  <tr key={`${p.in}-${p.name}`}>
                    <td>
                      <code>{p.name}</code>
                      {p.required && <span className="api-doc__req">obligatorio</span>}
                    </td>
                    <td className="api-doc__muted">
                      {p.in === 'body' ? 'cuerpo' : p.in === 'path' ? 'ruta' : 'query'}
                    </td>
                    <td className="api-doc__muted">{p.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <div className="api-doc__h3">Ejemplo</div>
        <CodeBlock code={buildPublicApiCurl(op, baseUrl)} />

        <div className="api-doc__h3">Respuesta ({op.successStatus})</div>
        <CodeBlock code={op.responseExample} />

        {op.errors.length > 0 && (
          <>
            <div className="api-doc__h3">Errores propios</div>
            <ErrorTable cases={op.errors} />
          </>
        )}
      </div>
    </details>
  );
}

/**
 * La guía: se pinta dentro de la pestaña "Documentación" de la pantalla API.
 * No es un modal a propósito, porque no es un aviso ni un formulario: es un
 * documento que se lee con una terminal al lado, se recorre a saltos y se
 * consulta mientras se prueba. Una capa encima que tapa el portal y se cierra
 * sola con un clic distraído estorba justo en ese uso.
 */
export function ApiDocsPanel() {
  return (
    <div className="api-doc">
      <p className="api-doc__lead">
        Todo lo que devuelve la API está acotado a tu casillero: la llave dice quién eres, así que
        no hace falta (ni se puede) indicar el cliente en cada petición.
      </p>

      <section className="api-doc__sec">
        <div className="api-doc__h2">1. La URL base</div>
        <CodeBlock code={baseUrl} />
        <p className="api-doc__p">
          Por sí sola no responde: a la base se le añade la ruta de la operación
          (<code>/client</code>, <code>/packages</code>…), como en el punto 3. Si pides la raíz, la
          respuesta es un <code>404</code> con el código <code>ROUTE_NOT_FOUND</code> aunque la
          llave sea correcta. Ese error trae la ruta <strong>exacta</strong> que recibimos, que es
          la forma de cazar una barra final o un espacio que se coló al copiar la dirección.
        </p>
      </section>

      <section className="api-doc__sec">
        <div className="api-doc__h2">2. Dónde va la llave</div>
        <p className="api-doc__p">
          Tu llave es la línea larga que copiaste al crearla. Empieza por <code>hsk_live_</code>
          {' '}(o <code>hsk_test_</code> si es de un entorno de pruebas) y tiene esta forma (esta es
          de ejemplo, no sirve):
        </p>
        <CodeBlock code={API_KEY_SAMPLE} />
        <p className="api-doc__p">
          Va en una <strong>cabecera</strong> de cada petición, con la palabra <code>Bearer</code> y
          un espacio delante de la llave. No hay usuario ni contraseña, y la llave no va ni en la
          dirección ni en el cuerpo:
        </p>
        <CodeBlock code={`Authorization: Bearer ${API_KEY_PLACEHOLDER}`} />
        <p className="api-doc__p">
          Si tu herramienta no te deja fijar <code>Authorization</code>, manda la llave sola en la
          cabecera <code>{API_KEY_HEADER}</code>. Aquí <strong>no</strong> va la palabra
          {' '}<code>Bearer</code>, solo la llave (con ella delante, la llave se rechaza):
        </p>
        <CodeBlock code={`${API_KEY_HEADER}: ${API_KEY_PLACEHOLDER}`} />
        <p className="api-doc__note">
          <strong>Con Postman, Insomnia o un ERP:</strong> muchas herramientas mandan su propia
          cabecera <code>Authorization</code> en cuanto hay algo puesto en su pestaña de
          autenticación, aunque tú hayas escrito la llave a mano en otro sitio. Si te pasa, deja esa
          pestaña en «No Auth» y manda la llave en <code>{API_KEY_HEADER}</code>: entre las dos
          cabeceras mandamos la nuestra, así que la llave se lee igual.
        </p>

        <div className="api-doc__h3">La misma petición, en tres formas</div>
        <p className="api-doc__p">
          Copia la que uses y sustituye <code>{API_KEY_PLACEHOLDER}</code> por tu llave completa.
        </p>
        <SnippetTabs />

        <div className="api-doc__h3">Si te responde 401</div>
        <ul className="api-doc__ul">
          <li>
            <code>API_KEY_MISSING</code>: no llegó ninguna de las dos cabeceras, o
            {' '}<code>Authorization</code> llegó sin la palabra <code>Bearer</code> delante.
          </li>
          <li>
            <code>API_KEY_INVALID</code>: la llave llegó cortada, con las comillas pegadas o es de
            otro entorno (una <code>test</code> contra producción). Pégala entera y sin comillas;
            los espacios de sobra alrededor sí se ignoran.
          </li>
          <li>
            <code>API_KEY_REVOKED</code>: esa llave se rotó o se revocó. Usa la vigente, o crea una
            en la pestaña «Llaves».
          </li>
        </ul>
        <p className="api-doc__note">
          La llave va en tu servidor, nunca en una página web ni en una app móvil: cualquiera que
          vea el código la puede leer. En la dirección tampoco funciona (la API no la lee de ahí a
          propósito: acabaría en registros de acceso y en el historial). Si sospechas que se filtró,
          rótala en la pestaña «Llaves».
        </p>
      </section>

      <section className="api-doc__sec">
        <div className="api-doc__h2">3. Operaciones</div>
        <p className="api-doc__p">
          Abre la que te interese para ver sus parámetros, el <code>curl</code> listo para pegar y
          la respuesta.
        </p>
        <div className="api-doc__ops">
          {PUBLIC_API_OPERATIONS.map((op) => (
            <Operation key={op.id} op={op} />
          ))}
        </div>
      </section>

      <section className="api-doc__sec">
        <div className="api-doc__h2">4. Límites de uso</div>
        <p className="api-doc__p">
          Hay un tope de peticiones por llave y por minuto. Cada respuesta trae cuánto te queda, así
          que tu sistema puede regularse solo en vez de reintentar a ciegas. Al pasarte, la
          respuesta es <code>429</code> con <code>Retry-After</code> en segundos.
        </p>
        <CodeBlock
          code={'X-RateLimit-Limit: 120\nX-RateLimit-Remaining: 118\nX-RateLimit-Reset: 1788172860'}
        />
        <p className="api-doc__note">
          Si consultas el estado de muchos paquetes, pide una página del listado
          (<code>GET /packages</code>) en vez de un paquete por petición: una llamada trae hasta
          cien.
        </p>
      </section>

      <section className="api-doc__sec">
        <div className="api-doc__h2">5. Errores</div>
        <p className="api-doc__p">
          Todos los errores tienen la misma forma. El <code>code</code> es estable y es sobre lo que
          conviene ramificar; el <code>message</code> está en español y puede cambiar.
        </p>
        <CodeBlock
          code={'{ "error": { "code": "API_KEY_REVOKED", "message": "Esa llave fue revocada..." } }'}
        />
        <ErrorTable cases={PUBLIC_API_COMMON_ERRORS} />
      </section>

      {/* La referencia larga (cada campo, el OpenAPI) sigue en el sitio publico:
          esta pagina es la del primer dia, no el manual entero. */}
      <div className="api-doc__foot">
        <span className="api-doc__muted-text">
          ¿Necesitas el detalle de cada campo o el documento OpenAPI para Postman?
        </span>
        <a className="btn btn-ghost" href="/desarrolladores" target="_blank" rel="noreferrer">
          Documentación completa
        </a>
      </div>
    </div>
  );
}
