/** @courier/shared — dominio compartido entre API y web. */
// Antes que nada: el sobre de paginacion lo fusionan los DTO de casi todos los modulos.
export * from './http/pagination';
export * from './money/currency';
export * from './auth/roles';
export * from './auth/permissions';
export * from './auth/user';
export * from './auth/session';
export * from './auth/dto';
// Despues de auth/*: depende del RBAC (quien puede fijar la tasa).
export * from './money/exchange-rate';
export * from './settings/exchange-rate-dto';
export * from './settings/freight-rate-dto';
export * from './users/dto';
export * from './tariffs/dto';
export * from './costs/cost-service';
export * from './costs/dto';
export * from './costs/shipment-cost';
export * from './costs/shipment-cost-dto';
export * from './providers/helga-states';
export * from './reports/report';
export * from './reports/dto';
export * from './reports/financials';
export * from './reports/proforma';
export * from './payments/payment';
export * from './payments/dto';
export * from './payments/consolidated';
export * from './deliveries/delivery';
export * from './deliveries/dto';
export * from './api-keys/api-key';
export * from './api-keys/dto';
export * from './clients/locker';
export * from './clients/dto';
export * from './clients/provider-link';
export * from './announcements/announcement';
export * from './announcements/dto';
export * from './files/attachments';
export * from './geo/costa-rica';
export * from './geo/routes';
export * from './shipments/catalogs';
export * from './shipments/shipment';
export * from './shipments/dto';
export * from './workflow/shipment-type';
export * from './workflow/states';
export * from './workflow/automation';
export * from './workflow/machine';
// Al final: el contrato de la API publica (`/api/v1`) se apoya en los esquemas
// de tramites y en el sobre de paginacion, asi que se exporta despues de ellos.
export * from './public-api/dto';
export * from './public-api/reference';
