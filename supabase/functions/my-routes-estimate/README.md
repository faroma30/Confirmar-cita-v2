# my-routes-estimate — servidor de Mis rutas

Edge Function de Supabase que calcula los desplazamientos de la jornada de un técnico con Geoapify (plan Free) y controla el **piloto** que limita su consumo.

> **El Supabase de la V2 no es el de Controla.** Son proyectos distintos (comprobado en CONFIRMAR_CITAS-005): las migraciones y despliegues de rutas no afectan a Controla.

## Origen y versión
- `index.ts`, `core.mjs`, `policy.mjs`, `route-agenda.mjs` y `../_shared/*` se incorporaron **tal cual** desde la versión desplegada **v8** (20/11/2026 09:49 UTC), recuperada en solo lectura en CONFIRMAR_CITAS-005. El commit «chore(routes): incorporar my-routes-estimate v8…» tiene los mismos bytes (hash por archivo); `.gitattributes` marca esta carpeta como `-text` para conservarlos.
- Cambio posterior (CONFIRMAR_CITAS-006, **sin desplegar**): `index.ts` llama a `cc_route_pilot_end` en el `finally` para liberar la reserva del piloto. Necesita la migración `20261125090000_route_pilot_release_lease.sql` (**sin aplicar**); mientras no se aplique, esa llamada devuelve un error que se ignora y el comportamiento es el de la v8.
- `route-agenda.mjs` repite la lógica de agenda de `my-routes.mjs` de la PWA: la huella de la jornada debe coincidir (prueba `tests/paridad-huella.test.mjs`, 7/7). Si cambia una, hay que cambiar la otra.

## Operaciones
| Cuerpo | Qué hace |
|---|---|
| `{ operation: "status", expectedActor }` | Devuelve el estado del piloto (`cc_route_pilot_status`) y `enabled` |
| `{ operation: "stop", expectedActor }` | **Solo Administrador** (CONFIRMAR_CITAS-007, `pilot-control.mjs`): perfil propio por `cc_my_profile` con `role = admin`, activo, verificado y sesión vigente; si no, **403** «Solo el administrador puede desactivar el piloto…» (`code: admin_only`). Para el piloto para **todos** (`cc_route_pilot_configure(null, true)`) y devuelve el estado. Técnico y Master no pueden |
| `{ operation: "autocomplete", query, kind, expectedActor }` | Sugerencias de calle (requiere `…_AUTOCOMPLETE_APPROVED = yes`) |
| `{ date, fingerprint, expectedActor, edits?, useHome? }` | Calcula los tramos de la jornada real del técnico; 409 si la huella no coincide. Con `useHome: true` (CONFIRMAR_CITAS-015) incluye el domicilio guardado del propio técnico; sin él, los tramos de casa salen como `privacy`. Un `useHome` que no sea booleano → 400 |

## Domicilio opcional y búsqueda de direcciones (CONFIRMAR_CITAS-015, sin desplegar)
- **Domicilio:** solo con `useHome: true`, que la PWA envía cuando el técnico activa «Usar mi domicilio…» en Ajustes de Mis rutas (desactivada por defecto, guardada en su dispositivo). El domicilio sale siempre de `cc_my_route_locations_v2` del propio llamante. El ámbito `home-and-activities` de `MY_ROUTES_GEOAPIFY_ACCESS` ya **no** envía el domicilio por sí solo; sigue sirviendo para el autocompletado `kind: "home"`.
- **Normalización** (`cleanOracleText`, `streetFields`): prefijos de vía duplicados, apóstrofos `´ ’`, mayúsculas, número en su propia parte. Provincia deducida del código postal (`provinceFromPostcode`, 01–52).
- **Elección** (`chooseCandidate`): mismo portal y calle; código postal **o** municipio coincidentes; gana el que coincide en ambos y tiene más confianza. Si dos destacan por igual, sigue siendo `not_found` (ambiguo).
- **Llamadas:** como máximo 2 por dirección (estructurada y, solo si no encuentra nada utilizable, texto libre con provincia y «España»). Cada una se reserva en el piloto (1 crédito) como hasta ahora; 401/403/429 sin cambios.

No existe operación para **reactivar** el piloto desde la app (ver «Reactivación diaria» y el diseño de administrador).

## Piloto
- Fila única `confirmar_citas.route_pilot_budget` (`stopped`, `external_usage`, `quota_verified_at`, `last_error`, `last_error_at`, `actor`, `lease`, `operation`) y reservas en `route_pilot_reservation`.
- Topes: **50 créditos** y **10 consultas de ruta** en 24 h; consumo externo declarado + reservado < 3000.
- Se **para solo** cuando Geoapify responde 401/403/429 (`provider_limited`) o un tramo supera la distancia reservada (`route_estimate_exceeded`).
- `active` = no parado **y** verificación de consumo (`quota_verified_at`) de menos de 24 h.
- Definiciones: `supabase/migrations/20261120050000_route_pilot_applied_reference.sql` (**YA APLICADA el 20/11/2026; solo referencia, no ejecutar**; si se usa la CLI: `supabase migration repair --status applied 20261120050000`).

## Reactivación diaria (con autorización; la hace el administrador)
1. Comprobar en el panel de Geoapify que la clave está activa y anotar el consumo real del día.
2. Ejecutar como `service_role` (editor SQL del proyecto de la V2):
   `select public.cc_route_pilot_configure(<consumo real de hoy, ≤ 2950>, false);`
   Pone `stopped = false` y renueva `quota_verified_at`.
3. **Caduca a las 24 h**: mientras dure el piloto hay que repetirlo cada día; si no, la PWA mostrará «Verificación de consumo caducada».

## Parar el piloto (Administrador)
El Administrador **no tiene la pestaña Mis rutas** (es solo para técnicos), así que en la app no ve «Desactivar piloto». Mientras no exista una opción en la zona de administración:
- **SQL** (editor SQL del proyecto de la V2, como `service_role`, con autorización): `select public.cc_route_pilot_configure(null, true);` → `stopped = true`. Comprobar con `select public.cc_route_pilot_status();`.
- **Función** (con su sesión de Administrador): `{ operation: "stop", expectedActor: <su id> }` a `my-routes-estimate`.
- **Propuesta (no implementada):** en el panel de administración, una tarjeta «Piloto de Mis rutas» con el estado (`status`), «Desactivar piloto» (`stop`, con confirmación) y, si se aprueba, «Reactivar piloto» (diseño de abajo).

## Configuración
- Secretos (solo nombres): `MY_ROUTES_GEOAPIFY_KEY`, `MY_ROUTES_GEOAPIFY_APPROVED` (= `yes`), `MY_ROUTES_GEOAPIFY_MANUAL_FREE_PILOT` (= `yes`), `MY_ROUTES_GEOAPIFY_ACCESS` (JSON `{ "<uuid técnico>": "activities" | "home-and-activities" }`), `MY_ROUTES_GEOAPIFY_AUTOCOMPLETE_APPROVED`, `SUPABASE_SECRET_KEY`/`SUPABASE_SERVICE_ROLE_KEY`, `APP_ORIGIN`. Nunca se guardan en el repositorio.
- PWA: en producción `config.js` lleva **`myRoutesGeoapifyEnabled: true`**; con `false` la pantalla no muestra los controles del piloto y dice que los tiempos de conducción están desactivados.

## Diseño (solo documentado, NO implementado): reactivar el piloto desde la app por un administrador
- Operación nueva `{ operation: "reactivate", expectedActor, externalUsage }` en la función, aceptada solo si el usuario autenticado es **administrador** (rol comprobado en la base por una RPC del llamante, no por el cliente) y figura en un secreto nuevo `MY_ROUTES_PILOT_ADMINS`.
- El administrador declara el **consumo real** de Geoapify (entero 0–2950) leído en el panel; la función llama a `cc_route_pilot_configure(externalUsage, false)` con `service_role`. Nunca se reactiva sin consumo declarado.
- Registro de auditoría (quién, cuándo, consumo declarado, error anterior) en una tabla nueva solo de inserción; límite de 3 reactivaciones al día.
- Rechazar si el último error es `provider_limited` de hace menos de 15 min (pausa global) y si `quota_verified_at` es de hace menos de 1 h (evita reactivaciones en bucle).
- En la PWA: botón «Reactivar piloto» solo para administradores, con el campo de consumo y confirmación. Parar ya es solo del Administrador (CONFIRMAR_CITAS-007); reactivar desde la app sigue pendiente de decisión del Director.

## Pruebas (sin red)
Desde la raíz del repositorio: `node --test tests/*.test.mjs wifi-connect/tests/*.test.mjs`.
La prueba SQL `supabase/tests/isolated/route-pilot-release-isolated.sql` necesita una base local o desechable con el esquema de la V2 y **no** se ejecuta contra el proyecto real.
