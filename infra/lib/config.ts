/**
 * Nombres y constantes que comparten los dos stacks y el pipeline.
 *
 * Estan aqui y no repetidos en cada archivo porque varios de ellos son un
 * CONTRATO con algo de fuera del CDK: el workflow de GitHub busca la instancia
 * por su etiqueta, y el script de arranque de la instancia lee los parametros
 * por su ruta. Si cambian en un sitio y no en el otro, el despliegue falla en
 * caliente, no al sintetizar.
 */

/** Prefijo de todo lo que nombramos nosotros. */
export const APP = 'courier';

/** Hoy solo hay produccion (docs/12: un entorno). Prefija rutas y nombres. */
export const ENVIRONMENT = 'prod';

/**
 * Ruta de Parameter Store con la configuracion de la API. El script de arranque
 * lee TODA la ruta y convierte cada parametro en una variable de entorno usando
 * su ultimo segmento, asi que el nombre del parametro es literalmente el nombre
 * de la variable: `/courier/prod/HELGA_MODE` -> `HELGA_MODE`.
 */
export const PARAMETER_PATH = `/${APP}/${ENVIRONMENT}`;

/** Grupo de CloudWatch donde el contenedor escribe su salida. */
export const LOG_GROUP = `/${APP}/${ENVIRONMENT}/api`;

/**
 * Etiqueta `Name` de la instancia. El workflow de despliegue la busca por aqui
 * y no por id: la instancia se reemplaza cuando cambia su script de arranque, y
 * un id fijo en el pipeline se quedaria apuntando a una maquina que ya no existe.
 */
export const INSTANCE_NAME = `${APP}-api`;

/** Repositorio autorizado a desplegar (confianza del rol OIDC). */
export const GITHUB_REPO = 'ABeens/courier-hit';

/** Unica rama desde la que se despliega. */
export const GITHUB_BRANCH = 'master';

/** Nombre de la base dentro de la instancia RDS. */
export const DATABASE_NAME = 'courier';

/**
 * Cuenta y region donde vive el sistema. Van FIJAS, no deducidas de las
 * credenciales que haya cargadas en ese momento.
 *
 * Son dos cosas distintas y las dos importan:
 *
 *  1. Un stack sin entorno explicito se despliega contra la cuenta que tenga la
 *     sesion activa. Con una sola cuenta parece dar igual, pero significa que un
 *     perfil equivocado despliega en el sitio equivocado sin avisar.
 *  2. Sin credenciales, el CDK no puede resolver la cuenta y falla con "Unable to
 *     resolve AWS account to use", que no dice lo que de verdad pasa (la sesion
 *     expiro). Fijandolas, el error que sale es el de credenciales, que es el
 *     problema real.
 *
 * La region es `us-east-1` porque es donde tiene que emitirse el certificado de
 * CloudFront y donde apunta SES.
 */
export const AWS_ACCOUNT = '632914961265';
export const AWS_REGION = 'us-east-1';

/** Dominio contratado. */
export const SITE_DOMAIN = 'hsglobal-services.com';

/**
 * Host canonico del sitio: `www`, no el apex.
 *
 * No es una preferencia de estilo, es lo unico que se puede hacer sin tocar el
 * DNS. La zona la sirve Squarespace y **ahi se queda**: tiene los MX y el SPF de
 * Google Workspace, y mover la zona a Route 53 para ganar un alias en el apex
 * pondria en riesgo el correo de la empresa, que vale mas que la estetica de la
 * URL. Y un apex no admite CNAME, asi que no puede apuntar a CloudFront.
 *
 * El apex se resuelve con el reenvio del panel de Squarespace hacia este host.
 * Todo lo que mire al sitio (canonical, `WEB_ORIGIN`, enlaces de los correos)
 * usa este valor.
 */
export const SITE_HOST = `www.${SITE_DOMAIN}`;

/**
 * Alias de la distribucion. El apex va tambien aunque hoy no lo alcance el
 * reenvio: el certificado lo cubre y asi el dia que la zona si este en Route 53
 * basta con crear el alias A, sin volver a tocar la distribucion.
 */
export const SITE_DOMAINS = [SITE_DOMAIN, SITE_HOST];

/**
 * Certificado del sitio, emitido en `us-east-1` (CloudFront no acepta otra
 * region). Va como constante y no como contexto porque es un dato del entorno
 * desplegado, igual que la cuenta: si vive en la linea de comandos, el que
 * despliegue sin acordarse se lleva por delante el alias de la distribucion.
 *
 * VACIO significa "todavia no hay certificado": la distribucion se queda con su
 * dominio de CloudFront y `WEB_ORIGIN` con el, que es exactamente el estado
 * anterior. Rellenarlo es lo que enciende el dominio propio, en un solo
 * despliegue.
 *
 * Ojo con el certificado: ACM da 72 horas para que aparezcan los registros CNAME
 * de validacion. Pasadas, el certificado queda en `VALIDATION_TIMED_OUT` y no
 * revive aunque los registros se pongan despues; hay que pedir uno nuevo.
 */
/**
 * Si el dominio RESUELVE de verdad, que es distinto de tener certificado.
 *
 * Son dos cosas separadas a proposito. El certificado y los alias ya estan
 * puestos, pero mientras no exista el CNAME de `www` en Squarespace nadie llega
 * por ese nombre, y apuntar ahi `WEB_ORIGIN` significaria mandar a los clientes
 * enlaces a un host que no existe. Con `false`, todo lo que mira al sitio usa la
 * URL de CloudFront, que si funciona.
 *
 * Se pone en `true` el dia que exista el registro, y basta con desplegar y
 * reiniciar: no hay nada mas que tocar.
 */
export const DOMAIN_LIVE = false;

export const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:632914961265:certificate/bb6d00ed-fce7-440b-a00c-1d671c820026';
