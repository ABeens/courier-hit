#!/usr/bin/env node
/**
 * Entrada del CDK. Dos stacks, un entorno (docs/12).
 *
 * La cuenta y la region estan FIJADAS en `lib/config.ts`, no salen del perfil de
 * AWS que tenga la sesion activa. Ahi esta el razonamiento.
 */
import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { BaseStack } from '../lib/base-stack';
import { APP, AWS_ACCOUNT, AWS_REGION, ENVIRONMENT } from '../lib/config';

const app = new App();

// Entorno explicito, no deducido de la sesion activa. El porque esta en
// `lib/config.ts`, junto a los valores.
const env = { account: AWS_ACCOUNT, region: AWS_REGION };

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
