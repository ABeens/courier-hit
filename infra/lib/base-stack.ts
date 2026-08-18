/**
 * Stack BASE: lo que tiene estado y no se debe recrear.
 *
 * La division en dos stacks no es cosmetica. Aqui viven la base de datos, los
 * archivos de los clientes y la IP que Helga tiene en su lista blanca; en el
 * stack de aplicacion (`app-stack.ts`) vive lo reemplazable (la instancia, la
 * distribucion, los permisos del pipeline). Asi se puede tirar y rehacer la capa
 * de aplicacion sin acercarse a nada que duela perder.
 *
 * Detalle de red: NO hay NAT Gateway. La opcion de computo elegida (docs/12 §4,
 * opcion C) es una instancia EC2 en subred publica con Elastic IP propia, que ya
 * da la IP de salida fija que exige Helga. El NAT costaria 32 USD/mes y aqui no
 * aporta nada: la base de datos vive en subredes aisladas y no necesita salir.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { APP, DATABASE_NAME, ENVIRONMENT } from './config';

export class BaseStack extends Stack {
  readonly vpc: ec2.Vpc;
  /** Grupo de seguridad de la instancia de la API. Vive aqui, ver nota abajo. */
  readonly apiSecurityGroup: ec2.SecurityGroup;
  readonly database: rds.DatabaseInstance;
  /**
   * OJO: el bucket del SITIO no esta aqui, esta en el stack de aplicacion. No es
   * una incoherencia con "lo persistente va en base": el contenido es desechable
   * (se regenera con un build) y su politica de acceso tiene que nombrar a la
   * distribucion de CloudFront. Teniendolo aqui, base pasaria a depender de app
   * y app ya depende de base por la red: CloudFormation no despliega un ciclo.
   */
  readonly uploadsBucket: s3.Bucket;
  readonly repository: ecr.Repository;
  readonly elasticIp: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- Red -----------------------------------------------------------------
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      // Sin NAT: la instancia sale por su propia Elastic IP (ver cabecera).
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // La base no sale a internet ni recibe de fuera: aislada de verdad.
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    /**
     * Los DOS grupos de seguridad y la regla que los une viven en este stack a
     * proposito. Si el de la instancia se declarara en el stack de aplicacion,
     * abrir el puerto de la base seria una referencia cruzada en los dos
     * sentidos (base -> app para la regla, app -> base para el grupo) y
     * CloudFormation no puede desplegar un ciclo entre stacks.
     */
    this.apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSg', {
      vpc: this.vpc,
      description: 'Instancia de la API. Entrada solo desde CloudFront.',
      allowAllOutbound: true,
    });

    /**
     * La instancia solo acepta trafico de CloudFront, nunca de internet abierto.
     * AWS publica la lista de direcciones de sus bordes como "managed prefix
     * list" y la mantiene al dia sola; lo unico que hace falta es su id, que
     * cambia por region. Se consulta al desplegar en vez de escribirlo a mano:
     * un id copiado de otra region abriria el puerto a nadie y la web caeria con
     * un 502 dificil de leer.
     */
    const cloudFrontPrefixList = new cr.AwsCustomResource(this, 'CloudFrontPrefixList', {
      onUpdate: {
        service: 'ec2',
        action: 'describeManagedPrefixLists',
        parameters: {
          Filters: [
            {
              Name: 'prefix-list-name',
              Values: ['com.amazonaws.global.cloudfront.origin-facing'],
            },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });

    this.apiSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cloudFrontPrefixList.getResponseField('PrefixLists.0.PrefixListId')),
      ec2.Port.tcp(80),
      'HTTP solo desde los bordes de CloudFront',
    );

    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: this.vpc,
      description: 'PostgreSQL. Solo alcanzable desde la API.',
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(
      this.apiSecurityGroup,
      ec2.Port.tcp(5432),
      'PostgreSQL desde la API',
    );

    // --- Base de datos -------------------------------------------------------
    this.database = new rds.DatabaseInstance(this, 'Database', {
      // Version mayor sin fijar el minor: RDS elige el ultimo y lo mantiene al
      // dia con `autoMinorVersionUpgrade`. Fijar "17.4" obligaria a tocar el
      // codigo cada vez que AWS retira un parche.
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of('17', '17'),
      }),
      // t4g.micro sobra para 175 paquetes al mes (docs/12 §0). Single-AZ: pasar a
      // Multi-AZ duplica el costo de computo y hoy no hay requisito de HA.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      multiAz: false,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      databaseName: DATABASE_NAME,
      // La contrasena la genera AWS y no pasa por el repo ni por nadie. El script
      // de arranque de la instancia arma el DATABASE_URL leyendo este secreto.
      credentials: rds.Credentials.fromGeneratedSecret('courier', {
        secretName: `${APP}/${ENVIRONMENT}/db`,
      }),
      allocatedStorage: 20,
      // Crece sola antes que quedarse sin disco, que es una caida total.
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(7),
      autoMinorVersionUpgrade: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
    });

    // --- Almacenamiento ------------------------------------------------------
    /**
     * Adjuntos: comprobantes de deposito y fotos de entrega. Es la prueba de un
     * pago y de una entrega, asi que va con versionado (un borrado o una
     * sobrescritura no lo pierden) y sobrevive al stack.
     */
    this.uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Las versiones antiguas son la red de seguridad de un borrado por
          // error, no un archivo historico: un año es de sobra y evita pagar
          // para siempre por cada sobrescritura.
          noncurrentVersionExpiration: Duration.days(365),
        },
      ],
    });

    // --- Registro de imagenes ------------------------------------------------
    this.repository = new ecr.Repository(this, 'ApiRepository', {
      repositoryName: `${APP}/api`,
      imageScanOnPush: true,
      // Cada despliegue deja una imagen; sin esto el repositorio crece sin fin.
      lifecycleRules: [{ maxImageCount: 10, description: 'Solo las 10 ultimas imagenes.' }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- IP fija de salida ---------------------------------------------------
    /**
     * LA PIEZA MAS DELICADA DEL STACK. Esta direccion es la que se registra en la
     * lista blanca de Helga (docs/12 §7.3); si cambia, la integracion responde
     * 403 a todo y el sistema deja de operar hasta que el proveedor apunte la
     * nueva. Por eso vive en el stack persistente y con RETAIN: la instancia se
     * puede reemplazar cuantas veces haga falta, la IP se queda.
     *
     * Ademas es la que da nombre al origen de CloudFront (ver `app-stack.ts`).
     */
    this.elasticIp = new ec2.CfnEIP(this, 'ApiEip', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `${APP}-api-egress` }],
    });
    this.elasticIp.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // --- Salidas -------------------------------------------------------------
    new CfnOutput(this, 'ApiElasticIp', {
      value: this.elasticIp.ref,
      description: 'IP fija de la API. Es la que hay que registrar en la lista blanca de Helga.',
    });
    new CfnOutput(this, 'UploadsBucketName', { value: this.uploadsBucket.bucketName });
    new CfnOutput(this, 'EcrRepositoryUri', { value: this.repository.repositoryUri });
    new CfnOutput(this, 'DatabaseSecretArn', {
      value: this.database.secret?.secretArn ?? 'sin secreto',
      description: 'Secreto con usuario y contrasena de PostgreSQL.',
    });
  }
}
