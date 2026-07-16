/**
 * Catalogo territorial de Costa Rica (Provincia > Canton > Distrito) del dominio
 * compartido. Lo consumen la web (selects encadenados del registro) y la API
 * (validar que el distrito pertenezca al canton y este a la provincia; no se
 * confia en lo que manda el cliente).
 *
 * Todos los usuarios son de Costa Rica (docs: autoregistro de casillero), por eso
 * este catalogo reemplaza al viejo `CITIES` colombiano. Los datos crudos y su
 * procedencia viven en `./costa-rica.data`.
 *
 * Convencion del repo: nombres de codigo en ingles; el dominio (nombres visibles
 * de provincias/cantones/distritos) en espanol.
 */
import { COSTA_RICA_PROVINCES } from './costa-rica.data';

/** Distrito: unidad territorial mas fina (codigo oficial de 5 digitos). */
export interface District {
  code: string;
  name: string;
}

/** Canton: agrupa distritos (codigo oficial de 3 digitos). */
export interface Canton {
  code: string;
  name: string;
  districts: readonly District[];
}

/** Provincia: agrupa cantones (codigo oficial de 1 digito). */
export interface Province {
  code: string;
  name: string;
  cantons: readonly Canton[];
}

/** Las 7 provincias con toda su jerarquia. Para el primer select del registro. */
export const PROVINCES: readonly Province[] = COSTA_RICA_PROVINCES;

// Indices por codigo, construidos una vez. Cada entrada guarda referencias a sus
// padres para resolver pertenencia en O(1) sin recorrer el arbol.
const provinceByCode = new Map<string, Province>();
const cantonByCode = new Map<string, { canton: Canton; province: Province }>();
const districtByCode = new Map<string, { district: District; canton: Canton; province: Province }>();

for (const province of PROVINCES) {
  provinceByCode.set(province.code, province);
  for (const canton of province.cantons) {
    cantonByCode.set(canton.code, { canton, province });
    for (const district of canton.districts) {
      districtByCode.set(district.code, { district, canton, province });
    }
  }
}

/** Provincia por codigo, o undefined si no existe. */
export function findProvince(provinceCode: string): Province | undefined {
  return provinceByCode.get(provinceCode);
}

/** Canton por codigo, o undefined si no existe. */
export function findCanton(cantonCode: string): Canton | undefined {
  return cantonByCode.get(cantonCode)?.canton;
}

/** Distrito por codigo, o undefined si no existe. */
export function findDistrict(districtCode: string): District | undefined {
  return districtByCode.get(districtCode)?.district;
}

/** Cantones de una provincia (para el segundo select). Vacio si la provincia no existe. */
export function getCantons(provinceCode: string): readonly Canton[] {
  return provinceByCode.get(provinceCode)?.cantons ?? [];
}

/** Distritos de un canton (para el tercer select). Vacio si el canton no existe. */
export function getDistricts(cantonCode: string): readonly District[] {
  return cantonByCode.get(cantonCode)?.canton.districts ?? [];
}

/** Distrito aplanado con el nombre y codigo de su canton y provincia. */
export interface DistrictListItem {
  provinceCode: string;
  provinceName: string;
  cantonCode: string;
  cantonName: string;
  districtCode: string;
  districtName: string;
}

/**
 * Aplana todo el catalogo a una fila por distrito, arrastrando el nombre y codigo
 * de su canton y provincia. Lo consume la pantalla de definicion de rutas, que
 * lista los 474 distritos para asignarles su numero de ruta.
 */
export function getAllDistricts(): DistrictListItem[] {
  const rows: DistrictListItem[] = [];
  for (const province of PROVINCES) {
    for (const canton of province.cantons) {
      for (const district of canton.districts) {
        rows.push({
          provinceCode: province.code,
          provinceName: province.name,
          cantonCode: canton.code,
          cantonName: canton.name,
          districtCode: district.code,
          districtName: district.name,
        });
      }
    }
  }
  return rows;
}

/**
 * Valida que la terna (provincia, canton, distrito) sea coherente: los tres
 * existen y el distrito cuelga del canton y este de la provincia. La API la usa
 * para no aceptar combinaciones cruzadas o inventadas desde el cliente.
 */
export function isValidLocation(
  provinceCode: string,
  cantonCode: string,
  districtCode: string,
): boolean {
  const entry = districtByCode.get(districtCode);
  if (!entry) return false;
  return entry.canton.code === cantonCode && entry.province.code === provinceCode;
}
