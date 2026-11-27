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

## Pausas y «Desplazamiento» (CONFIRMAR_CITAS-016, opción A)
- Toda actividad cuyo nombre empiece por Comida, Almuerzo, Pausa o Descanso (también en plural y con texto extra) es por defecto una **pausa sin desplazamiento**. El técnico puede cambiarlo en la tarjeta; la app lo envía en `edits` (`travel: "travel"`). Ya no hay actividades «pendientes de decidir».
- Una actividad «Desplazamiento» sin dirección queda como tramo pendiente («Actividad de desplazamiento sin destino: no se calcula»): su dirección vacía no se busca en Geoapify y no gasta créditos.
- La regla es la misma en `route-agenda.mjs` y en `my-routes.mjs` de la PWA (misma huella). **La función v9 y la web 3routes13 usan la regla anterior:** se publican juntas, primero la función.

No existe operación para **reactivar** el piloto desde la app (ver «Reactivación diaria» y el diseño de administrador).

## Piloto
- Fila única `confirmar_citas.route_pilot_budget` (`stopped`, `external_usage`, `quota_verified_at`, `last_error`, `last_error_at`, `actor`, `lease`, `operation`) y reservas en `route_pilot_reservation`.
- Topes: **1.000 créditos** y **200 consultas de ruta** en 24 h (CONFIRMAR_CITAS-025, migración `20261127090000_route_pilot_limits_1000.sql`, **pendiente de aplicar**: hasta entonces siguen 50 y 10); consumo externo declarado + reservado < 3000.
- Los topes viven en la fila única `confirmar_citas.route_pilot_limits`. **Tope de seguridad:** la base rechaza más de **2.500 créditos** al día y más consultas que créditos.
- Se **para solo** cuando Geoapify responde 401/403/429 (`provider_limited`) o un tramo supera la distancia reservada (`route_estimate_exceeded`).
- `active` = no parado **y** verificación de consumo (`quota_verified_at`) de menos de 24 h.
- Definiciones: `supabase/migrations/20261120050000_route_pilot_applied_reference.sql` (**YA APLICADA el 20/11/2026; solo referencia, no ejecutar**; si se usa la CLI: `supabase migration repair --status applied 20261120050000`).

## Reactivación diaria (con autorización; la hace el administrador)
1. Comprobar en el panel de Geoapify que la clave está activa y anotar el consumo real del día.
2. Ejecutar como `service_role` (editor SQL del proyecto de la V2):
   `select public.cc_route_pilot_configure(<consumo real de hoy, ≤ 2950>, false);`
   Pone `stopped = false` y renueva `quota_verified_at`.
3. ~~Caduca a las 24 h~~: desde CONFIRMAR_CITAS-024 se **renueva solo** cada 24 h mientras esté activado (ver abajo). Este paso solo hace falta para **reactivar** un piloto parado o para declarar otro consumo.

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
Las pruebas SQL `supabase/tests/isolated/route-pilot-release-isolated.sql` y `route-pilot-limits-isolated.sql` necesitan una base local o desechable con el esquema de la V2 y **no** se ejecutan contra el proyecto real.

## Tramos parciales y motivo por tramo (CONFIRMAR_CITAS-017, build 3routes15)
- **Cálculo parcial:** si una dirección no se resuelve, se calculan igualmente los tramos cuyos dos extremos sí se resolvieron. Los tramos que tocan la dirección fallida no consultan ruta (0 llamadas de `routing`).
- **Respuesta:** `{ estimates, reasons, details }`. `reasons` mantiene el vocabulario de 3routes14 (`privacy`, `incomplete`, `not_found`, `no_route`); `details` es **opcional** y da un código estable por tramo: `privacy`, `incomplete`, `missing_number`, `street_not_found`, `portal_not_found`, `ambiguous`, `other_end`, `other_end_incomplete`, `pilot_limit`, `no_route` (o `null` si el tramo se calculó). Nunca se devuelve ni se registra la respuesta de Geoapify ni coordenadas.
- **Comparación tolerante** (`sameStreet`, `sameMunicipality`): acentos y apóstrofos (también `´`), artículos catalanes y castellanos (`de`, `del`, `dels`, `de la`, `de les`, `d'`, `d'en`, `de l'`, `la`, `el`, `els`, `les`, `na`) en cualquier posición, tipos de vía equivalentes (Calle/Carrer/C., Avenida/Avinguda/Av., Plaza/Plaça/Pl., Paseo/Passeig/Pg., Camino/Camí, Carretera/Ctra.) y municipio igual sin acentos (también en `town`/`village`). Sigue exigiendo España, el mismo portal y código postal **o** municipio coincidentes; dos sitios igual de probables siguen siendo `ambiguous`.
- **Tope del piloto:** si el presupuesto del piloto rechaza una llamada cuando ya hay tramos calculados, se devuelven esos tramos y el resto sale como `pilot_limit` (el piloto lo registra como `quota`, igual que antes). Sin ningún tramo calculado, 429 como antes. Los rechazos de Geoapify (401/403/429) siguen deteniendo el piloto.
- **Corrección:** la PWA 3routes15 envía en `edits` la dirección corregida en «Editar desplazamiento» (mismas reglas que `parseActivityEdits`); el recálculo la usa y la huella coincide.
- **Compatibilidad:** la web 3routes14 ignora `details`; la web 3routes15 con la función v10 usa `reasons`.

## Direcciones reales de Oracle y código de detalle (CONFIRMAR_CITAS-018, build 3routes16)
- **Abreviaturas de tipo de vía** (con y sin punto o barra), expandidas antes de buscar y usadas en la comparación: `PTGE`/`PTG` Passatge, `PJE`/`PSJE`/`PJ` Pasaje, `PG` Passeig, `PS`/`PSO`/`Pº` Paseo, `CTRA`/`CRTA` Carretera, `AV`/`AVD`/`AVDA` Avenida, `AVGDA`/`AVG` Avinguda, `PL`/`PZA`/`PZ`/`PLZ` Plaza, `PÇA`/`PCA` Plaça, `RDA` Ronda, `RBLA` Rambla, `TRAV` Travessera, `TRV`/`TV` Travesía, `CM`/`CNO` Camino, `URB` Urbanización, `POL`/`POLIG` Polígono, `BDA` Barriada, `C/`/`C.`/`CL` Calle. Las ambiguas (`PSG`, `CR`) se quitan y la calle se busca solo por el nombre.
- **Calle sin tipo de vía:** se busca con el nombre (`street=<nombre>`, `housenumber=<portal>`) y se acepta el candidato cuyo nombre coincide, sea cual sea su tipo.
- **Portal:** `9A`, `9 A`, `9-11` (→ `9`), `Nº 9`, `NUM 9`, `9 bis`. Se **descartan** piso, puerta, escalera, bajo y local (`2º`, `2ª`, `2n 1a`, `BJ`, `BAJO`, `ESC A`, `PTA 3`, `PISO 2`, `LOCAL`): nunca se envían a Geoapify. `S/N`: no se busca (`missing_number`); la PWA dice «Dirección sin número: corrígela en Editar desplazamiento».
- **Dos formas del portal en las mismas 2 llamadas:** la estructurada usa el portal con letra (`9A`) y el texto libre, el número solo (`9`). Se acepta el portal exacto, su número sin letra o un rango que lo contiene; el exacto gana. Un número distinto nunca se acepta.
- **Municipio:** artículos en minúscula («Ribes De Freser» → «Ribes de Freser») y comparación sin acentos ni mayúsculas.
- **Respuesta:** campo nuevo y **opcional** `diagnostics`, un código por tramo sin tiempo con la causa de la dirección que lo bloquea: `no_results`, `street_mismatch`, `municipality_mismatch`, `postcode_mismatch`, `number_mismatch`, `ambiguous`, `missing_number`, `missing_street` (o `null`). Solo códigos: nunca la dirección, la respuesta de Geoapify ni coordenadas, y no se registran.
- **Compatibilidad:** la web 3routes15 ignora `diagnostics`; la web 3routes16 con la función v11 no muestra la línea de detalle. La huella de la jornada no cambia.

## CartoCiudad primero para las direcciones (CONFIRMAR_CITAS-020, build 3routes17)
- **Orden:** cada dirección se busca primero en **CartoCiudad** (IGN-CNIG, servicio público gratuito, licencia CC BY 4.0), como máximo 2 llamadas: `findJsonp?q=<calle> <número>, <municipio>` y, si no da un portal utilizable, `candidates?q=<calle> <número>&limit=5&cod_postal_filter=<CP>` (sin CP, el municipio va en el texto). Si tampoco, **Geoapify como hasta ahora** (máximo 2 llamadas, solo en ese caso). Geoapify sigue calculando **solo las rutas** entre coordenadas.
- **Formato** (Fase A del 020, 2.ª ronda: portal exacto en 10–11 de 13 lugares públicos): nombre de la calle **sin tipo de vía ni artículos iniciales** («Plaça de l'Ajuntament» → «Ajuntament»), número sin letra, y municipio; el CP como filtro. Con el tipo y las partículas en el texto, CartoCiudad devolvía `[]` (1.ª ronda: 1 de 12).
- **Aceptación:** tipo `portal`, misma calle (`sameStreet`, con su tipo: la Plaza Mayor no es la Calle Mayor), mismo número y mismo CP **o** municipio; con varios, gana el que coincide en CP y municipio; un empate no se acepta. Pedido `9A`, vale el `9A` o el `9`; pedido `9`, un `9A` no. Tipo `callejero` (vial) con coordenadas: se usa la posición de la calle y el tramo sale **«aprox.»** con el código `number_mismatch` (decisión del Director solo para el caso en que la base oficial no tiene el portal). Municipio, topónimo u otro tipo: nunca.
- **Datos enviados:** solo `q` (calle y número, y el municipio), `limit` y `cod_postal_filter`. Nunca piso, puerta, escalera, nombres ni teléfonos.
- **Fiabilidad:** 5 s como máximo por llamada (y nunca con menos de 10 s de margen para Geoapify dentro de los 55 s). Si CartoCiudad falla, responde con error o va lento, la dirección pasa a Geoapify y **el resto de la jornada ya no espera a CartoCiudad**. Sus fallos no gastan créditos de Geoapify, no paran el piloto ni activan `provider_limited`; solo se registra `{ event: "cartociudad_attempt_failed", stage, kind, http }`, sin direcciones.
- **Respuesta:** campos nuevos y **opcionales** `approx` (por tramo, `true` si se calculó con la posición de una calle) y `sources` (por dirección: `cartociudad`, `geoapify` o `null`). `diagnostics` también se devuelve en los tramos «aprox.». Nunca coordenadas ni textos de dirección.
- **Interruptor:** con la variable `MY_ROUTES_CARTOCIUDAD=no` la función vuelve al comportamiento de la v12 (sin CartoCiudad), sin desplegar de nuevo.
- **Respuesta en ISO-8859-1:** se decodifica por el `charset` o, si no es UTF-8 válido, como windows-1252 (en la Fase A los acentos llegaban rotos al leerlos como UTF-8).
- **Atribución en Mis rutas:** «Direcciones: CartoCiudad © IGN-CNIG (CC BY 4.0) · Rutas: Geoapify» (y la línea de Geoapify y OpenStreetMap de siempre).
- **Compatibilidad:** la web 3routes16 ignora `approx` y `sources` (y no muestra el detalle en tramos con tiempo); la web 3routes17 con la función v12 no muestra «aprox.» ni el origen. La huella de la jornada no cambia (`route-agenda.mjs` y `policy.mjs` intactos).

## Calle oficial, domicilio siempre y asistente de direcciones (CONFIRMAR_CITAS-022, build 3routes18)
- **Calle oficial más parecida:** si `findJsonp` no conoce la calle, la 2.ª llamada pide los viales del municipio **sin número** (`candidates?q=<calle>&limit=10&cod_postal_filter=<CP>`; sin CP, `q=<calle>, <municipio>`). Se comparan los nombres sin tipo de vía, artículos, acentos ni mayúsculas (Levenshtein normalizado). Con **una sola** calle ≥ 0,85, al menos 0,1 por encima de la segunda y de la misma clase de vía, la 3.ª llamada busca el portal en ella (`findJsonp`). Con dudas no se decide: la 3.ª llamada es la de siempre (`candidates` con número y CP) y, si la dirección no se encuentra, se devuelven hasta 3 calles oficiales del mismo municipio. Si la lista sale vacía no hay 3.ª llamada. **Máximo 3 llamadas a CartoCiudad y 2 a Geoapify por dirección**; CartoCiudad no gasta créditos.
- **Respuesta:** campos nuevos y **opcionales**, por dirección: `officials` (calle oficial usada o `null`) y `suggestions` (`null` o hasta 3 `{ street, number, municipality, postalCode, province? }` que la app aplica como `edits`). Solo nombres de calles públicas y los datos de la propia agenda del técnico; nunca coordenadas.
- **Domicilio:** se usa **siempre** (decisión del Director del 26/11/2026; sustituye la casilla del 015): `providerPlan(addresses, true)`. `useHome` se sigue aceptando (booleano) por compatibilidad con 3routes17; otro tipo da 400.
- **Modo `suggest`** (asistente de direcciones): `{ operation: "suggest", query, municipality?, postalCode?, expectedActor }`. Comprueba la sesión, `expectedActor`, `MY_ROUTES_GEOAPIFY_ACCESS` y `cc_my_route_locations_v2`, **no reserva el piloto ni gasta créditos** y no necesita la clave de Geoapify. Una llamada a `candidates` (texto sin tipo ni artículos iniciales, municipio en el texto y CP como filtro). Devuelve hasta 6 `{ street, number, municipality, province?, postalCode, label }`. Con `MY_ROUTES_CARTOCIUDAD=no` responde 503. El modo `autocomplete` de Geoapify se conserva, pero la app ya no lo usa.
- **Compatibilidad:** la web 3routes17 ignora `officials` y `suggestions`; la web 3routes18 con la v13 envía `useHome: true` y, sin el modo `suggest` (400), deja escribir a mano. La huella de la jornada no cambia.

## Sugerencias sin depender del CP y todas las calles del mismo nombre (CONFIRMAR_CITAS-023, build 3routes19)
- **Modo `suggest`:** con municipio, la 1.ª llamada es `candidates?q=<texto>, <municipio>&limit=10` **sin** `cod_postal_filter` (un CP guardado puede no ser el oficial: con él CartoCiudad no devuelve nada). Solo se quedan las del mismo municipio (sin acentos ni mayúsculas) y el CP, si lo hay, **solo ordena** (primero las que coinciden). Solo si no queda ninguna, una 2.ª llamada con el CP como filtro (se aceptan las de ese CP). Sin municipio, la búsqueda de siempre. Máximo **2 llamadas** por sugerencia (`SUGGEST_MAX_CALLS`); nunca Geoapify ni el piloto.
- **Calle oficial:** si la lista de calles con `cod_postal_filter` sale vacía, un reintento por municipio sin CP; como ya no queda llamada para buscar el portal, las calles oficiales se **sugieren** (nunca se eligen solas). Máximo 3 llamadas a CartoCiudad y 2 a Geoapify por dirección.
- **«¿Querías decir…?»:** las calles oficiales con el mismo nombre y distinto tipo («Avenida …», «Plaça …», «Paseo …») son calles distintas: se ofrecen todas (hasta 3) con su tipo. Si el tipo de Oracle (p. ej. `PTGE`) no está entre las oficiales, no se elige ninguna automáticamente.
- **App:** el bloque de sugerencias de una dirección sale una sola vez (el tramo siguiente solo da el motivo); al elegir una sugerencia sin número se vacía el número anterior y el foco va a «Número o S/N».
- **Compatibilidad:** sin campos nuevos en la respuesta. La web 3routes18 con la función nueva recibe más sugerencias; la web 3routes19 con la v14 funciona igual que la 3routes18 (solo sin las mejoras del servidor). La huella de la jornada no cambia.

## Renovación automática diaria del piloto (CONFIRMAR_CITAS-024, build 3routes20)
- **Sin migración ni tarea programada** (`pilot-renewal.mjs`). La base sigue caducando la verificación a las 24 h (`cc_route_pilot_begin/charge/status` sin cambios); la función la renueva **al consultar** («status» y antes de cada `cc_route_pilot_begin`) con `cc_route_pilot_configure(<mismo externalUsageAtVerification>, false)`.
- **Solo si:** `stopped = false`, `active = false`, `quotaVerifiedAt` no vacío y de hace 24 h o más, consumo externo guardado entero 0–2950 y cálculo aprobado (`enabled`). Si no, no se escribe nada.
- **Nunca** renueva un piloto desactivado por el Administrador ni parado por 401/403/429 o distancia excedida (los dos dejan `stopped = true`). Reactivarlo sigue siendo SQL del Administrador (arriba).
- **Mismos topes:** los de la base (1.000 créditos y 200 consultas de ruta desde CONFIRMAR_CITAS-025; antes 50 y 10) en una **ventana móvil** de 24 h; renovar no borra los cobros de las últimas 24 h (no se regala otro cupo). El consumo externo declarado no cambia.
- **«Desactivar piloto» gana:** la renovación no escribe si su lectura tiene más de 1 s (`RENEW_MAX_STALE_MS`) y `stop` vuelve a comprobar a los 2,5 s (`STOP_RECHECK_MS`) y vuelve a parar si una renovación concurrente lo dejó activado. Sigue siendo solo del Administrador (403 para técnico y Master); no hay operaciones ni claves de entrada nuevas.
- **Respuesta de `status`/`stop`:** añade `autoRenew: true` y `nextRenewalAt` (ISO, o `null` si está parado). La web 3routes20 muestra «Se renueva solo cada 24 h mientras esté activado, con el mismo límite (próxima renovación: DD/MM a las HH:MM)» y ya no dice que caduca; si no se pudo renovar, «El piloto no se ha podido renovar solo… Avisa al administrador».
- **Registro:** `{ event: "route_pilot_renewed" }` (sin datos personales).
- **Compatibilidad:** la web 3routes19 ignora los campos nuevos; la web 3routes20 con la v15 muestra los mensajes de antes. La huella de la jornada no cambia.

## Causa de un 429 (CONFIRMAR_CITAS-026, pendiente de publicar)

La respuesta 429 sigue llevando `error` y añade, cuando se sabe, `code`: `wait`, `busy`, `credits_limit`,
`routes_limit`, `shared_limit`, `external_limit`, `provider_limited`, `route_too_long`, `pilot_stopped`,
`pilot_unverified` o `budget_refused`. Solo la espera del propio técnico lleva `retryAfterSeconds` (1–120); la
respuesta correcta de un cálculo también lo lleva para la cuenta atrás. Sin cifras internas ni datos de otros.
`wait`, `busy`, `shared_limit` y los segundos necesitan la migración `20261127120000_route_budget_wait.sql`
(solo añade `cc_route_budget_wait`, lectura, `service_role`; **escrita y no aplicada**). Sin ella la función
responde como antes en esos casos. No cambian topes, esperas ni el tratamiento de 401/403/429 de Geoapify.
