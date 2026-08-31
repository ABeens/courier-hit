/**
 * Stack de APLICACION: lo reemplazable.
 *
 * La instancia que corre la API, la distribucion que la publica, la
 * configuracion en Parameter Store y el rol con el que GitHub Actions despliega.
 * Nada de aqui guarda estado: se puede destruir y volver a crear sin perder
 * datos (eso vive en `base-stack.ts`, incluida la Elastic IP).
 *
 * Forma de la entrada (docs/12 §2.2): UNA sola distribucion sirve el sitio
 * estatico y la API bajo `/api/*`. La sesion es una cookie httpOnly `SameSite=Lax`,
 * asi que bajo el mismo host es trivialmente same-origin: no hay CORS que ajustar
 * ni `SameSite` que relajar.
 */
import {
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { BaseStack } from './base-stack';
import {
  CERTIFICATE_ARN,
  DOMAIN_LIVE,
  GITHUB_BRANCH,
  GITHUB_REPO,
  INSTANCE_NAME,
  LOG_GROUP,
  PARAMETER_PATH,
  SITE_DOMAIN,
  SITE_DOMAINS,
  SITE_HOST,
} from './config';

export interface AppStackProps extends StackProps {
  readonly base: BaseStack;
  /**
   * ARN de un proveedor OIDC de GitHub que ya exista en la cuenta. Solo puede
   * haber UNO por cuenta, asi que si otro proyecto ya lo creo hay que reusarlo
   * en vez de crearlo (el despliegue fallaria con "already exists").
   */
  readonly githubOidcProviderArn?: string;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const { base } = props;
    const imageUri = base.repository.repositoryUri;

    /**
     * Sitio compilado. Privado: solo lo lee CloudFront, con Origin Access
     * Control. Vive en este stack porque su politica de acceso tiene que nombrar
     * a la distribucion (ver la nota en `base-stack.ts`), y porque el contenido
     * es desechable: lo repone un build.
     */
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Registro de logs del contenedor -------------------------------------
    // Creado aqui y no por el driver de Docker para poder fijarle retencion: sin
    // ella, CloudWatch guarda para siempre y el costo crece solo (docs/12 §5.1).
    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: LOG_GROUP,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    // --- Permisos de la instancia --------------------------------------------
    const instanceRole = new iam.Role(this, 'ApiInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Rol de la instancia de la API.',
      managedPolicies: [
        // Session Manager: entrar a la maquina sin abrir SSH ni guardar llaves.
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    base.repository.grantPull(instanceRole);
    base.uploadsBucket.grantReadWrite(instanceRole);
    base.database.secret?.grantRead(instanceRole);
    logGroup.grantWrite(instanceRole);

    // Configuracion de la app. `GetParametersByPath` pide permiso sobre la RUTA,
    // y las lecturas sueltas sobre cada parametro: van los dos recursos.
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParametersByPath', 'ssm:GetParameters', 'ssm:GetParameter'],
        resources: [
          this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PARAMETER_PATH.slice(1) }),
          this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${PARAMETER_PATH.slice(1)}/*` }),
        ],
      }),
    );

    // Los parametros SecureString (credenciales de Helga, Onvo) se cifran
    // con la llave gestionada `aws/ssm`. Descifrarlos necesita permiso propio,
    // acotado a que la peticion venga de SSM y no de cualquier otro servicio.
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }),
    );

    // Correo saliente. SES no acota por recurso a este nivel de uso; el remitente
    // real lo limita el dominio verificado, no esta politica.
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      }),
    );

    // --- Arranque de la instancia --------------------------------------------
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y docker jq',
      'systemctl enable --now docker',
      'mkdir -p /opt/courier',

      // El script de despliegue. Es el MISMO que invoca el pipeline por SSM: un
      // solo camino para el primer arranque y para cada version posterior.
      `cat > /opt/courier/deploy.sh <<'DEPLOY_SCRIPT'
#!/bin/bash
# Despliega una version de la API en esta instancia. Uso: deploy.sh <tag>
set -euo pipefail

REGION="${this.region}"
REPOSITORY="${imageUri}"
PARAMETER_PATH="${PARAMETER_PATH}"
DB_SECRET="${base.database.secret?.secretArn ?? ''}"
ENV_FILE=/opt/courier/api.env
TAG="\${1:-latest}"

echo "[deploy] desplegando \${REPOSITORY}:\${TAG}"

aws ecr get-login-password --region "\$REGION" \\
  | docker login --username AWS --password-stdin "\${REPOSITORY%%/*}"
docker pull "\${REPOSITORY}:\${TAG}"

# Entorno: cada parametro de la ruta se vuelve una variable con el nombre de su
# ultimo segmento. umask 077 porque aqui aterrizan credenciales descifradas.
umask 077
: > "\$ENV_FILE"
aws ssm get-parameters-by-path \\
  --path "\$PARAMETER_PATH" --recursive --with-decryption \\
  --region "\$REGION" --output json \\
  | jq -r '.Parameters[] | "\\(.Name | split("/") | last)=\\(.Value)"' >> "\$ENV_FILE"

# La cadena de conexion se arma aqui y no se guarda en ningun sitio: la
# contrasena la genera y la rota AWS. sslmode=require porque RDS solo habla TLS.
SECRET=\$(aws secretsmanager get-secret-value --secret-id "\$DB_SECRET" \\
  --region "\$REGION" --query SecretString --output text)
DB_URL=\$(printf '%s' "\$SECRET" \\
  | jq -r '"postgres://\\(.username):\\(.password|@uri)@\\(.host):\\(.port)/\\(.dbname)?sslmode=require"')
echo "DATABASE_URL=\${DB_URL}" >> "\$ENV_FILE"

echo "IMAGE=\${REPOSITORY}:\${TAG}" > /opt/courier/image.env

# Migraciones ANTES de arrancar, con la imagen nueva: el esquema y el codigo que
# lo usa entran juntos. Si fallan, el servicio viejo sigue en pie.
docker run --rm --env-file "\$ENV_FILE" "\${REPOSITORY}:\${TAG}" node dist/migrate.js

systemctl daemon-reload
systemctl enable courier-api
systemctl restart courier-api
echo "[deploy] listo"
DEPLOY_SCRIPT`,
      'chmod 700 /opt/courier/deploy.sh',

      `cat > /etc/systemd/system/courier-api.service <<'UNIT'
[Unit]
Description=API de HS Global Services
After=docker.service network-online.target
Requires=docker.service

[Service]
EnvironmentFile=/opt/courier/image.env
Restart=always
RestartSec=5
TimeoutStartSec=0
ExecStartPre=-/usr/bin/docker rm -f courier-api
ExecStart=/usr/bin/docker run --rm --name courier-api \\
  -p 80:3001 \\
  --env-file /opt/courier/api.env \\
  --log-driver=awslogs \\
  --log-opt awslogs-region=${this.region} \\
  --log-opt awslogs-group=${LOG_GROUP} \\
  \${IMAGE}
ExecStop=/usr/bin/docker stop courier-api

[Install]
WantedBy=multi-user.target
UNIT`,
      'systemctl daemon-reload',

      // Primer arranque: en el despliegue inicial todavia no hay imagen en ECR,
      // y eso no debe dejar la instancia a medio configurar. El pipeline vuelve
      // a llamar a este mismo script en cuanto publica la primera version.
      '/opt/courier/deploy.sh latest || echo "[deploy] sin imagen en ECR todavia; esperando al pipeline"',
    );

    const instance = new ec2.Instance(this, 'Api', {
      vpc: base.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // t4g = Graviton (arm64). La imagen se construye para esa arquitectura;
      // ver la nota de plataformas en apps/api/Dockerfile.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: base.apiSecurityGroup,
      role: instanceRole,
      userData,
      // El script de arranque ES la definicion del servidor: si cambia, la
      // instancia se reemplaza para que el cambio se aplique de verdad. Es
      // seguro porque aqui no hay estado y la IP fija vive en el otro stack.
      userDataCausesReplacement: true,
      requireImdsv2: true,
      // Publica desde el primer segundo: el arranque necesita salir a ECR antes
      // de que CloudFormation asocie la Elastic IP.
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    Tags.of(instance).add('Name', INSTANCE_NAME);

    new ec2.CfnEIPAssociation(this, 'ApiEipAssociation', {
      allocationId: base.elasticIp.attrAllocationId,
      instanceId: instance.instanceId,
    });

    // --- Origen de la API para CloudFront ------------------------------------
    /**
     * CloudFront exige un NOMBRE DE DOMINIO como origen; una IP no le vale. El
     * nombre publico que AWS le da a una direccion elastica es derivable de la
     * propia IP cambiando los puntos por guiones, asi que se construye aqui con
     * intrinsecas de CloudFormation en vez de fijarlo a mano. Resuelve siempre a
     * la Elastic IP, que es fija: el origen no cambia aunque se reemplace la
     * instancia.
     *
     * En us-east-1 el sufijo es `compute-1`; en el resto, `<region>.compute`.
     */
    const dashedIp = Fn.join('-', Fn.split('.', base.elasticIp.ref));
    const apiOriginDomain =
      this.region === 'us-east-1'
        ? `ec2-${dashedIp}.compute-1.amazonaws.com`
        : `ec2-${dashedIp}.${this.region}.compute.amazonaws.com`;

    /**
     * Reescritura de rutas en el borde. Hacen falta dos cosas que S3 no hace por
     * si mismo cuando se sirve como origen REST (no como sitio web):
     *
     *  1. Indice de directorio: Astro compila `/contacto` como
     *     `/contacto/index.html`, y el navegador pide `/contacto`.
     *  2. Fallback del portal: `/app/*` es una SPA con router propio. Las rutas
     *     que no tienen pagina generada (docs/12 y el comentario de
     *     `pages/app/[...path].astro`) deben servir la cascara para que React
     *     resuelva la pantalla desde la URL.
     *
     * Solo se asocia al comportamiento por defecto: `/api/*` no pasa por aqui.
     */
    const rewriteFunction = new cloudfront.Function(this, 'RewriteFunction', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // Portal: toda ruta bajo /app sirve la misma cascara.
  if (uri === '/app' || uri.indexOf('/app/') === 0) {
    request.uri = '/app/index.html';
    return request;
  }

  // Indice de directorio.
  if (uri.charAt(uri.length - 1) === '/') {
    request.uri = uri + 'index.html';
    return request;
  }

  // Ruta sin extension: es una pagina, no un archivo.
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }

  return request;
}
`),
    });

    /**
     * Dominio propio, si ya hay certificado (ver `CERTIFICATE_ARN` en
     * `config.ts`). Se resuelve por ARN y no con `DnsValidatedCertificate`
     * porque la zona no esta en Route 53: los registros de validacion se ponen a
     * mano en el proveedor de DNS, y el CDK no tiene forma de esperarlos.
     */
    const certificate = CERTIFICATE_ARN
      ? acm.Certificate.fromCertificateArn(this, 'SiteCertificate', CERTIFICATE_ARN)
      : undefined;

    /**
     * Origen publico del sitio. Depende de `DOMAIN_LIVE`, NO del certificado:
     * tener certificado no significa que el nombre resuelva. Es `www` y no el
     * apex; el porque esta en `SITE_HOST`.
     */
    const siteUrl = DOMAIN_LIVE ? `https://${SITE_HOST}` : undefined;

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'HS Global Services: sitio + API',
      defaultRootObject: 'index.html',
      // Alias y certificado van juntos: CloudFront rechaza un `domainNames` sin
      // certificado que lo cubra. Sin certificado, ninguno de los dos.
      ...(certificate ? { domainNames: SITE_DOMAINS, certificate } : {}),
      // Norteamerica y Europa. Los clientes estan en Costa Rica y la operacion en
      // Miami: pagar por los bordes de Asia y Oceania no compra nada.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [
          {
            function: rewriteFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiOriginDomain, {
            // HTTP, no HTTPS: sin dominio propio no hay certificado valido que
            // poner en la instancia (ACM solo emite para dominios que controlas)
            // y CloudFront rechaza un certificado autofirmado. El tramo
            // navegador -> CloudFront SI va cifrado. Ver docs/12: al cerrar el
            // dominio, este origen pasa a HTTPS.
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            readTimeout: Duration.seconds(30),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // Una API con sesion no se cachea NUNCA.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Cabeceras, cookies y query intactas: la cookie de sesion y el
          // `X-Webhook-Secret` de Onvo tienen que llegar tal cual.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      },
      // OJO: sin `errorResponses` a proposito. Son de la distribucion ENTERA, no
      // por comportamiento: un 404 o un 403 legitimo de la API (que los usa, ver
      // el contrato {error:{code,message}}) se convertiria en el HTML del sitio y
      // el portal no podria leer el error. El fallback de la SPA ya lo resuelve
      // la funcion de reescritura, que si es por comportamiento.
    });

    // --- Configuracion de la app (Parameter Store) ---------------------------
    /**
     * Solo los valores NO secretos. CloudFormation no sabe crear parametros
     * SecureString, asi que las credenciales (Helga, Onvo) se cargan una
     * vez con la CLI; ver `infra/README.md`. El script de arranque lee la ruta
     * entera y no distingue entre unos y otros.
     *
     * Estos valores son CODIGO: si alguien los cambia en la consola, el siguiente
     * despliegue los devuelve a lo que dice este archivo.
     */
    const parameters: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: '3001',
      AWS_REGION: this.region,
      // Sigue al dominio propio en cuanto haya certificado. Es la lista blanca de
      // CORS y la raiz de los enlaces que salen por correo: si se queda en el
      // dominio de CloudFront, el portal servido desde el dominio propio no puede
      // hablar con la API.
      WEB_ORIGIN: siteUrl ?? `https://${distribution.distributionDomainName}`,
      UPLOADS_BUCKET: base.uploadsBucket.bucketName,

      // Integraciones apagadas en el primer despliegue. Se encienden una a una
      // cuando su tramite externo esta listo (docs/12 §8): SES fuera del sandbox,
      // la IP en la lista blanca de Helga, las llaves de Onvo.
      MAIL_ENABLED: 'false',
      // El remitente tiene que estar VERIFICADO en SES. Se verifico la direccion
      // suelta y no el dominio entero, porque verificar el dominio son tres CNAME
      // en Squarespace y el acceso al panel no es nuestro (docs/15 §1.3). El
      // precio: los correos los firma `amazonses.com` y no el dominio, o sea algo
      // mas de riesgo de spam. Se arregla poniendo los tres CNAME algun dia, sin
      // tocar esto.
      MAIL_FROM: `HS Global Services <servicioalcliente@${SITE_DOMAIN}>`,
      HELGA_MODE: 'off',
      ONVO_MODE: 'on',
      // La tasa de referencia sí va encendida desde el primer despliegue: no
      // depende de ningun tramite externo (API publica, sin credenciales).
      HACIENDA_ENABLED: 'true',
      MIAMI_LINK_ENABLED: 'false',
      // El robot solo tiene tareas de Helga: encenderlo antes no agenda nada.
      ROBOT_ENABLED: 'false',
    };

    for (const [name, value] of Object.entries(parameters)) {
      new ssm.StringParameter(this, `Param${name}`, {
        parameterName: `${PARAMETER_PATH}/${name}`,
        stringValue: value,
      });
    }

    // --- Rol de despliegue para GitHub Actions -------------------------------
    const oidcProvider = props.githubOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubOidc',
          props.githubOidcProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'courier-github-deploy',
      description: 'Rol que asume GitHub Actions para desplegar. Sin llaves de acceso.',
      // Confianza acotada a UNA rama de UN repositorio: un fork o una rama
      // cualquiera no pueden asumirlo aunque conozcan el ARN.
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:ref:refs/heads/${GITHUB_BRANCH}`,
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });

    base.repository.grantPullPush(deployRole);
    webBucket.grantReadWrite(deployRole);

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [
          this.formatArn({
            service: 'cloudfront',
            region: '',
            resource: 'distribution',
            resourceName: distribution.distributionId,
          }),
        ],
      }),
    );

    // Desplegar la API = pedirle a la instancia que corra su propio script. El
    // pipeline no entra a la maquina ni guarda llaves SSH.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          this.formatArn({ service: 'ssm', region: '', account: '', resource: 'document', resourceName: 'AWS-RunShellScript' }),
        ],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [this.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' })],
        // Solo la instancia de la API, identificada por su etiqueta.
        conditions: { StringEquals: { 'ssm:resourceTag/Name': INSTANCE_NAME } },
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        // Seguir el comando hasta saber si fue bien, y localizar la instancia por
        // etiqueta (su id cambia cada vez que se reemplaza).
        actions: [
          'ssm:GetCommandInvocation',
          'ssm:ListCommandInvocations',
          'ec2:DescribeInstances',
        ],
        resources: ['*'],
      }),
    );

    // --- Salidas -------------------------------------------------------------
    new CfnOutput(this, 'SiteUrl', {
      value: siteUrl ?? `https://${distribution.distributionDomainName}`,
      description: 'URL publica del sitio y de la API (/api/*).',
    });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'Destino del CNAME de www en Squarespace.',
    });
    new CfnOutput(this, 'WebBucketName', {
      value: webBucket.bucketName,
      description: 'Bucket del sitio compilado. Destino del sync del pipeline.',
    });
    new CfnOutput(this, 'ApiInstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'GithubDeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Valor del secreto AWS_DEPLOY_ROLE_ARN en GitHub.',
    });
  }
}
