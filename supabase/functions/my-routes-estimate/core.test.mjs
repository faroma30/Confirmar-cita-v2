import test from "node:test";
import assert from "node:assert/strict";
import { calculateJourney, journeyAddresses, journeyFingerprint, streetFields } from "./core.mjs";
import { buildLegs, combineActivities } from "../../../multiusuario/my-routes.mjs";
import { createCloudRoutes, routeFingerprint } from "../../../multiusuario/my-routes-cloud.mjs";

const home = "Calle Sintética 10, 28000 Madrid";
const jobs = [{scheduled_time:"10:00",full_address:"Calle Prueba 12, piso reservado",postal_code:"28000",population:"Madrid"}];
const ignored = [{time:"09:00",type:"Mantenimiento",full_address:"Calle Ensayo 14",postal_code:"28000",population:"Madrid"},
  {time:"12:00",type:"Valoración"}];

test("servidor y navegador coinciden en orden y tramos con direcciones ausentes", async () => {
  const legs = buildLegs(home, combineActivities(jobs, ignored));
  assert.equal(await journeyFingerprint(journeyAddresses(home, jobs, ignored)), await routeFingerprint(legs));
  assert.equal(streetFields("Calle 10 sin datos de municipio"), null);
  assert.deepEqual(streetFields(journeyAddresses(home, jobs, ignored)[2]), {
    street:"Calle Prueba",housenumber:"12",postcode:"28000",city:"Madrid",country:"España",filter:"countrycode:es",limit:"1",
  });
});

test("Geoapify recibe solo campos estructurados y coordenadas; reserva antes de consultar", async () => {
  const events = [];
  const estimates = await calculateJourney(journeyAddresses(home, jobs, ignored), {
    apiKey:"fake-test-key",
    charge:async amount => { events.push(amount); return true; },
    fetcher:async (url, options) => {
      assert.equal(url.hostname,"api-eu.geoapify.com");
      assert.equal(options.headers,undefined);
      assert.doesNotMatch(url.href,/reservado|telefono|notas|jwt/i);
      const p = url.searchParams;
      const number = p.get("housenumber");
      events.push(url.pathname);
      if (number) return Response.json({results:[{country_code:"es",postcode:"28000",
        housenumber:number,lat:40 + Number(number)/1000,lon:-3,rank:{confidence_building_level:0.95}}]});
      assert.equal(p.get("mode"),"drive");
      assert.equal(p.get("units"),"metric");
      return Response.json({features:[{properties:{distance:1200,time:240}}]});
    },
  });
  assert.deepEqual(estimates.map(x=>x?.durationSeconds ?? null),[240,240,null,null]);
  assert.deepEqual(events,[1,"/v1/geocode/search",1,"/v1/geocode/search",1,"/v1/geocode/search",2,"/v1/routing",2,"/v1/routing"]);
});

test("límite y rechazo del proveedor detienen las solicitudes pendientes", async () => {
  const addresses = [home,"Calle Prueba 12, 28000 Madrid",home];
  const failIfCalled = () => assert.fail("no se autorizó la salida");
  await assert.rejects(calculateJourney(addresses,{apiKey:"key",charge:async()=>false,fetcher:failIfCalled}),{status:429});
  for (const status of [403,429,0]) {
    let requests = 0;
    await assert.rejects(calculateJourney(addresses,{
      apiKey:"key",charge:async()=>true,fetcher:async()=>{
        requests++;
        if (!status) throw Error("sensitive detail");
        return new Response("",{status});
      },
    }),{message:"Route service unavailable",status:status ? 429 : 503,providerLimited:Boolean(status)});
    assert.equal(requests,1);
  }
});

test("cliente deduplica por jornada y descarta los resultados al cambiar de usuario", async () => {
  const legs = buildLegs(home, combineActivities(jobs, []));
  let actor = {id:"A",role:"technician"}, calls = 0, finish;
  const provider = createCloudRoutes({getActor:()=>actor,invoke:async(name, options)=>{
    calls++;
    assert.equal(name,"my-routes-estimate");
    assert.deepEqual(Object.keys(options.body).sort(),["date","expectedActor","fingerprint"]);
    assert.doesNotMatch(JSON.stringify(options),/Sintética|Prueba/);
    return new Promise(resolve=>{ finish=resolve; });
  }});
  const options = {date:"2026-11-17"};
  const one = provider.estimateJourney(legs,options), two = provider.estimateJourney(legs,options);
  while (!finish) await new Promise(setImmediate);
  await new Promise(setImmediate);
  actor = {id:"B",role:"master"};
  finish({data:{estimates:[{distanceMeters:33},{distanceMeters:44}]}});
  assert.deepEqual(await one,[]);
  assert.deepEqual(await two,[]);
  assert.deepEqual(await provider.estimateJourney(legs,options),[]);
  assert.equal(calls,1);
});
