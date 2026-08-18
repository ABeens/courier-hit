#!/usr/bin/env node
/**
 * Entrada del CDK. Dos stacks, un entorno (docs/12).
 *
 * La region y la cuenta salen del perfil de AWS con el que se ejecuta, con
 * `us-east-1` por defecto: es donde tiene que vivir el certificado de CloudFront
 * y donde esta apuntado SES en la configuracion.
 */
import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { BaseStack } from '../lib/base-stack';
import { APP, ENVIRONMENT } from '../lib/config';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const base = new BaseStack(app, `${APP}-${ENVIRONMENT}-base`, {
  env,
  description: 'Red, base de datos, buckets, registro de imagenes e IP fija.',
});

new AppStack(app, `${APP}-${ENVIRONMENT}-app`, {
  env,
  description: 'Instancia de la API, CloudFront, configuracion y rol de despliegue.',
  base,
  // Solo puede existir un proveedor OIDC de GitHub por cuenta. Si otro proyecto
  // ya lo creo: cdk deploy -c githubOidcProviderArn=arn:aws:iam::...
  githubOidcProviderArn: app.node.tryGetContext('githubOidcProviderArn'),
});
