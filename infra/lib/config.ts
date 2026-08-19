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
