const CONFIG = {
  santaMarta: { lat: 11.2408, lon: -74.2110 },
  weather: 'https://api.open-meteo.com/v1/forecast',
  ideam: {
    dailyFlow: 'jxnq-r3i9',
    hourlyFlow: '79gx-f3v5',
    stationCatalog: 'hp9r-jxuu',
  },
  rivers: {
    manzanares: { name:'Río Manzanares', basin:'Manzanares', lat:11.2063, lon:-74.0989, responseMin:3, responseMax:6, color:'#48d7cf', stationHints:['MANZANARES','BOCAT STA MARTA','AUTO MANZANARES','SAN P. ALEJANDRINO'] },
    gaira: { name:'Río Gaira', basin:'Gaira', lat:11.1403, lon:-74.1197, responseMin:4, responseMax:8, color:'#5db5ff', stationHints:['MINCA','GAIRA'] },
    guachaca: { name:'Río Guachaca', basin:'Guachaca', lat:11.2475, lon:-73.8392, responseMin:3, responseMax:7, color:'#f7c769', stationHints:['GUACHACA'] },
  },
  demo: {
    manzanares: { flow: 8.7, delta: 8.4, rainfall24: 19.4, forecast24: 22.8 },
    gaira: { flow: 5.4, delta: -2.3, rainfall24: 14.6, forecast24: 17.1 },
    guachaca: { flow: 11.2, delta: 15.8, rainfall24: 28.6, forecast24: 34.7 },
  }
};

const $ = s => document.querySelector(s);
let map, hydroChart;
let mapLayers = {};
let weatherState = null;
let liveHydro = {};

function fmt(n, d=1){ if(n===null || n===undefined || Number.isNaN(Number(n))) return '—'; return Number(n).toLocaleString('es-CO',{maximumFractionDigits:d,minimumFractionDigits:d}); }
function fmt0(n){ if(n===null || n===undefined) return '—'; return Number(n).toLocaleString('es-CO',{maximumFractionDigits:0}); }
function showPage(page){
  document.querySelectorAll('.side-link').forEach(b=>b.classList.toggle('active', b.dataset.target===page));
  if(page!=='metodologia'){
    document.querySelectorAll('.page-section').forEach(p=>p.classList.remove('active'));
    document.getElementById('inicio').classList.add('active');
  }
  if(page==='inicio'){ window.scrollTo({top:0,behavior:'smooth'}); return; }
  const targets={mapa:'#mapa',pronostico:'#pronostico',historico:'#historico',metodologia:'#metodologia-page'};
  if(page==='mapa' || page==='pronostico' || page==='historico'){ const el=document.querySelector(targets[page]); if(el) el.scrollIntoView({behavior:'smooth',block:'start'}); }
  if(page==='metodologia') renderMethodology();
}

document.querySelectorAll('.side-link').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.target)));

function initMap(){
  map=L.map('map',{zoomControl:true,scrollWheelZoom:true}).setView([11.205,-74.13],10.9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);

  const riverLines={
    manzanares:[[11.294,-74.255],[11.275,-74.241],[11.255,-74.226],[11.235,-74.214],[11.214,-74.194],[11.194,-74.184]],
    gaira:[[11.185,-74.180],[11.169,-74.192],[11.156,-74.202],[11.142,-74.209],[11.126,-74.216]],
    guachaca:[[11.300,-73.790],[11.281,-73.807],[11.263,-73.827],[11.2475,-73.8392],[11.227,-73.850],[11.207,-73.863]]
  };
  Object.entries(riverLines).forEach(([key,coords])=>{
    const r=CONFIG.rivers[key];
    L.polyline(coords,{color:r.color,weight:5,opacity:.85,lineCap:'round'}).bindTooltip(r.name,{sticky:true}).addTo(map);
    L.polyline(coords,{color:'#ffffff',weight:1,opacity:.28}).addTo(map);
  });

  mapLayers.stations=L.layerGroup().addTo(map);
  Object.entries(CONFIG.rivers).forEach(([key,r])=>{
    const marker=L.circleMarker([r.lat,r.lon],{radius:7,color:'#061522',weight:2,fillColor:r.color,fillOpacity:1});
    marker.bindPopup(`<b>${r.name}</b><br><span style="color:#86a7b8">Punto representativo de cuenca</span><br><br>La estación real se cargará desde el catálogo del IDEAM.`);
    marker.addTo(mapLayers.stations);
  });

  map.on('mousemove', e=>{
    // Mantener el mapa sobrio; la coordenada se muestra solo al hacer clic.
  });
  map.on('click', e=>{
    L.popup({closeButton:true}).setLatLng(e.latlng).setContent(`<b>Consulta espacial</b><br>Lat ${e.latlng.lat.toFixed(5)} · Lon ${e.latlng.lng.toFixed(5)}`).openOn(map);
  });

  $('#focusSM').addEventListener('click',()=>map.setView([11.2408,-74.2110],12));
  $('#toggleRainLayer').addEventListener('click',()=>toggleRainLayer());
}

function toggleRainLayer(){
  if(!mapLayers.rain){
    mapLayers.rain=L.layerGroup();
    [[11.24,-74.21,'Santa Marta'],[11.20,-74.18,'Piedemonte'],[11.14,-74.12,'Minca'],[11.25,-73.84,'Guachaca']].forEach((p,i)=>{
      const rain=[weatherState?.last24||0,weatherState?.last24||0,weatherState?.last24*1.35||0,weatherState?.last24*1.6||0][i];
      L.circleMarker([p[0],p[1]],{radius:10+Math.min(20,rain),color:'#f7c769',fillColor:'#f7c769',fillOpacity:.12,weight:1}).bindTooltip(`${p[2]} · lluvia aprox. ${fmt(rain)} mm`).addTo(mapLayers.rain);
    });
  }
  if(map.hasLayer(mapLayers.rain)) map.removeLayer(mapLayers.rain); else mapLayers.rain.addTo(map);
}

async function fetchLocalSnapshot(){
  const res=await fetch(`data/latest.json?ts=${Date.now()}`,{cache:'no-store'});
  if(!res.ok) throw new Error(`Snapshot ${res.status}`);
  const snapshot=await res.json();
  if(snapshot.hydrology) liveHydro=snapshot.hydrology;
  if(snapshot.forecast?.hourly){
    weatherState={
      ...(weatherState||{}),
      last24:snapshot.rainfall?.santa_marta?.last24_mm ?? null,
      future24:snapshot.forecast.next24_mm ?? null,
      times:snapshot.forecast.hourly.time||[],
      precip:snapshot.forecast.hourly.precipitation||[],
      prob:snapshot.forecast.hourly.probability||[]
    };
  }
  return snapshot;
}

async function fetchWeather(){
  const params=new URLSearchParams({latitude:CONFIG.santaMarta.lat,longitude:CONFIG.santaMarta.lon,timezone:'auto',past_days:'2',forecast_days:'3',current:'temperature_2m,precipitation,rain,cloud_cover,wind_speed_10m',hourly:'precipitation,rain,temperature_2m,precipitation_probability'});
  const res=await fetch(`${CONFIG.weather}?${params}`);
  if(!res.ok) throw new Error('No se pudo consultar el pronóstico meteorológico');
  const data=await res.json();
  const times=data.hourly?.time||[], precip=data.hourly?.precipitation||[], prob=data.hourly?.precipitation_probability||[];
  const now=Date.now();
  const past24=[]; const future24=[];
  times.forEach((t,i)=>{const ms=new Date(t).getTime(); if(ms<=now && ms>now-24*3600e3) past24.push(precip[i]||0); if(ms>now && ms<=now+24*3600e3) future24.push(precip[i]||0);});
  weatherState={data,last24:past24.reduce((a,b)=>a+b,0),future24:future24.reduce((a,b)=>a+b,0),times,precip,prob};
  return weatherState;
}

function findKey(obj, patterns){
  const keys=Object.keys(obj||{});
  return keys.find(k=>patterns.some(p=>k.toLowerCase().includes(p)));
}
function rowDate(row){
  const key=findKey(row,['fecha','date','datetime','fecha_hora','timestamp','tiempo']);
  const value=key?row[key]:Object.values(row).find(v=>typeof v==='string' && /20\d\d[-/]/.test(v));
  const d=value?new Date(value):null; return d && !Number.isNaN(d.getTime())?d:null;
}
function rowStation(row){
  const keys=Object.keys(row); const candidates=keys.filter(k=>/(estacion|station|nombre|corriente|rio|codigo)/i.test(k));
  return candidates.map(k=>String(row[k]??'')).join(' | ').toUpperCase();
}
function rowFlow(row){
  const key=findKey(row,['caudal','q_media','q_']);
  if(key!==undefined){ const n=Number(String(row[key]).replace(',','.')); if(Number.isFinite(n)) return n; }
  const vals=Object.entries(row).filter(([k,v])=>typeof v==='number' && /q|caudal|flow/i.test(k));
  return vals.length?Number(vals[0][1]):null;
}

async function fetchSocrataSearch(datasetId, query){
  const url=`https://www.datos.gov.co/resource/${datasetId}.json?$q=${encodeURIComponent(query)}&$limit=250`;
  const res=await fetch(url,{headers:{Accept:'application/json'}});
  if(!res.ok) throw new Error(`Socrata ${res.status}`);
  return res.json();
}
async function fetchHydrology(){
  const result={};
  for(const [key,r] of Object.entries(CONFIG.rivers)){
    let rows=[];
    try{
      for(const hint of r.stationHints.slice(0,2)){
        const candidate=await fetchSocrataSearch(CONFIG.ideam.hourlyFlow,hint);
        rows=rows.concat(candidate);
      }
      if(!rows.length){
        for(const hint of r.stationHints.slice(0,2)) rows=rows.concat(await fetchSocrataSearch(CONFIG.ideam.dailyFlow,hint));
      }
    }catch(err){
      console.warn('IDEAM no disponible en esta sesión:',err);
    }
    const parsed=rows.map(row=>({row,date:rowDate(row),text:rowStation(row),flow:rowFlow(row)})).filter(x=>x.date&&x.flow!==null);
    parsed.sort((a,b)=>b.date-a.date);
    const latest=parsed.find(x=>r.stationHints.some(h=>x.text.includes(h))) || parsed[0];
    if(latest) result[key]={flow:latest.flow,date:latest.date.toISOString(),source:'IDEAM'};
  }
  return result;
}

function classifyDelta(delta){
  if(delta>8) return {label:'EN ASCENSO',cls:'up'};
  if(delta<-8) return {label:'EN DESCENSO',cls:'down'};
  return {label:'ESTABLE',cls:'flat'};
}
function buildRiverData(){
  const rain24=weatherState?.last24 ?? CONFIG.demo.manzanares.rainfall24;
  const rainNext=weatherState?.future24 ?? CONFIG.demo.manzanares.forecast24;
  const out={};
  Object.entries(CONFIG.rivers).forEach(([key,r])=>{
    const hyd=liveHydro[key]||CONFIG.demo[key];
    const multiplier = key==='guachaca'?1.35:key==='gaira'?.92:1;
    const localRain24=weatherState ? rain24*multiplier : hyd.rainfall24;
    const next=weatherState ? rainNext*multiplier : hyd.forecast24;
    const delta=hyd.delta ?? (next-localRain24)*0.5;
    const trend=classifyDelta(delta);
    out[key]={
      ...r,
      flow:hyd.flow,
      delta:hyd.delta_pct ?? delta,
      rain24:localRain24,
      forecast24:next,
      trend:classifyDelta(hyd.delta_pct ?? delta),
      source:hyd.source||'SIMULADO',
      responseMin:hyd.responseMin ?? r.responseMin,
      responseMax:hyd.responseMax ?? r.responseMax,
      calibrated:Boolean(hyd.calibrated),
      calibrationNote:hyd.calibrationNote || ''
    };
  });
  return out;
}
function updateUI(){
  const rivers=buildRiverData();
  const lead=rivers.gauchaca||rivers.guachaca;
  const sorted=Object.entries(rivers).sort((a,b)=>Math.abs(b[1].delta)-Math.abs(a[1].delta));
  const primary=sorted[0]?.[1]||rivers.manzanares;
  $('#kpiFlow').textContent=fmt(primary.flow,1);
  $('#kpiRiver').textContent=primary.name;
  $('#kpiTrend').textContent=primary.trend.label;
  $('#kpiTrend').className=`trend ${primary.trend.cls}`;
  $('#kpiRain').textContent=fmt(primary.rain24,1);
  $('#kpiForecast').textContent=fmt(primary.forecast24,1);
  $('#kpiRainSignal').textContent=primary.forecast24>=25?'Señal fuerte de lluvia':primary.forecast24>=8?'Lluvia probable':'Sin señal fuerte';
  $('#kpiWindow').textContent=`${primary.responseMin}–${primary.responseMax}`;
  $('#kpiWindowRiver').textContent=primary.name;

  const rising=primary.forecast24>=8;
  const title=rising?`Posible respuesta en ${primary.name}`:`Señal seca / estable en ${primary.name}`;
  $('#signalTitle').textContent=title;
  const calibrationText=primary.calibrated
    ? 'La ventana está calibrada con series históricas.'
    : 'La ventana sigue siendo preliminar hasta completar la calibración histórica.';

  $('#signalCopy').textContent=rising
    ? `El pronóstico aporta ${fmt(primary.forecast24,1)} mm para las próximas 24 h. Bajo el modelo actual, la cuenca podría empezar a responder aproximadamente ${primary.responseMin}–${primary.responseMax} h después del evento de lluvia. ${calibrationText}`
    : `La señal de precipitación prevista es baja. Si el periodo seco se mantiene, el caudal puede continuar descendiendo respecto a su referencia reciente. ${calibrationText}`;
  $('#signalRing span').textContent=primary.trend.label==='EN ASCENSO'?'↑':primary.trend.label==='EN DESCENSO'?'↓':'→';
  $('#signalFill').style.width=Math.min(95,Math.max(12,primary.forecast24*2.1))+'%';

  $('#riverList').innerHTML=Object.entries(rivers).map(([key,r])=>`<button class="river-row" data-river="${key}" style="width:100%;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer"><i class="river-dot" style="background:${r.color};box-shadow:0 0 0 4px ${r.color}18"></i><span class="river-main"><b>${r.name}</b><span>${r.source==='IDEAM'?'IDEAM':'Demo'} · lluvia 24 h ${fmt(r.rain24,1)} mm</span></span><span class="river-state"><strong>${fmt(r.flow,1)}</strong><span>${r.trend.label}</span></span></button>`).join('');
  document.querySelectorAll('.river-row').forEach(b=>b.addEventListener('click',()=>{ $('#riverSelect').value=b.dataset.river; updateChart(b.dataset.river); document.getElementById('historico').scrollIntoView({behavior:'smooth'}); }));

  renderTimeline(primary);
  renderForecast();
  updateChart($('#riverSelect').value);
  $('#updatedAt').textContent='Actualización: '+new Date().toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'});
}

function renderTimeline(r){
  const hours=[0,3,6,9,12,15,18,21];
  const base=Math.max(0,r.forecast24/8);
  $('#timeline').innerHTML=hours.map((h,i)=>{const rain=base*(i===2?1.8:i===3?1.25:i>3?.45:.2);const height=Math.max(6,Math.min(44,rain*13));return `<div class="timeline-item"><div class="timeline-time">+${h}h</div><div class="timeline-bar" style="height:${height}px"></div><div class="timeline-rain">${fmt(rain,1)}</div><div class="timeline-desc">mm</div></div>`}).join('');
  const label=r.forecast24>=8?`Ventana estimada: lluvia → respuesta del río entre <strong>${r.responseMin} y ${r.responseMax} horas</strong>. La señal es orientativa y se calibrará con la serie histórica.`:`Ventana estimada: <strong>sin evento de lluvia significativo</strong>. Se vigilará la continuidad del descenso durante la temporada seca.`;
  $('#responseNote').innerHTML=label;
}
function renderForecast(){
  const times=weatherState?.times||[]; const precip=weatherState?.precip||[]; const now=Date.now(); const future=[];
  times.forEach((t,i)=>{const ms=new Date(t).getTime(); if(ms>now && future.length<6) future.push({t,mm:precip[i]||0});});
  const vals=future.length?future:[0,4,7,2,0,1].map((mm,i)=>({t:new Date(Date.now()+i*3*3600e3).toISOString(),mm}));
  $('#forecastStrip').innerHTML=vals.map(x=>`<div class="forecast-item"><div class="forecast-time">${new Date(x.t).toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'})}</div><div class="forecast-icon">${x.mm>=4?'🌧️':x.mm>0?'🌦️':'☼'}</div><div class="forecast-mm">${fmt(x.mm,1)} mm</div></div>`).join('');
  const total=weatherState?.future24 ?? buildRiverData().manzanares.forecast24; $('#forecast24').textContent=fmt(total,1);
  $('#weatherSource').textContent=weatherState?'Open‑Meteo':'Demo · Open‑Meteo';
}

function updateChart(riverKey){
  const r=buildRiverData()[riverKey]||buildRiverData().manzanares;
  const labels=['−24h','−21h','−18h','−15h','−12h','−9h','−6h','−3h','Ahora','+3h','+6h','+9h','+12h','+15h','+18h','+21h'];
  const center=r.flow||7;
  const flow=labels.map((_,i)=>center*(0.87+0.03*i)+(r.delta>0?Math.max(0,i-8)*r.delta/25:Math.min(0,i-8)*Math.abs(r.delta)/35));
  const rain=labels.map((_,i)=>i<9?(r.rain24/18)*(i%4===0?1.4:.35):(r.forecast24/20)*(i%3===0?1.7:.25));
  if (!window.Chart) {
    const area = document.querySelector('#historico .chart-area');
    if (area) {
      const max = Math.max(...flow, ...rain, 1);
      area.innerHTML = `<div class="chart-fallback" role="img" aria-label="Vista esquemática de caudal y lluvia">${labels.map((label, i) => `<div class="chart-fallback-col"><span class="flow-bar" style="height:${Math.max(4, flow[i] / max * 100)}%"></span><span class="rain-bar" style="height:${Math.max(3, rain[i] / max * 100)}%"></span><small>${label}</small></div>`).join('')}</div><p class="chart-fallback-caption">Gráfico visual de respaldo. Se activará el gráfico completo cuando Chart.js esté disponible.</p>`;
    }
    return;
  }

  if(hydroChart) hydroChart.destroy();
  hydroChart=new Chart($('#hydroChart'),{type:'line',data:{labels,datasets:[{label:'Caudal (m³/s)',data:flow,borderColor:'#4ed8ce',backgroundColor:'rgba(78,216,206,.12)',fill:true,tension:.38,yAxisID:'y',pointRadius:0},{label:'Lluvia (mm)',data:rain,borderColor:'#f7c769',borderDash:[5,5],tension:.38,yAxisID:'y1',pointRadius:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#a9c0cb',boxWidth:11,font:{size:9}}}},scales:{x:{grid:{color:'rgba(145,176,196,.07)'},ticks:{color:'#668294',font:{size:8}}},y:{position:'left',grid:{color:'rgba(145,176,196,.07)'},ticks:{color:'#668294',font:{size:8}}},y1:{position:'right',grid:{display:false},ticks:{color:'#9a8356',font:{size:8}}}}}});
}

function renderMethodology(){
  const html=`<section class="page-section active"><div class="glass-card" style="padding:20px"><div class="eyebrow">METODOLOGÍA</div><h1 style="font-family:'Space Grotesk';margin:7px 0 10px">Cómo vamos a predecir la respuesta del río</h1><p style="color:#95afbc;max-width:800px;line-height:1.6;font-size:11px">La V1 separa tres capas: observación (caudal + lluvia), pronóstico meteorológico y un modelo de respuesta cuenca–río. Primero mostramos la señal; después calibramos el tiempo de respuesta con la historia de cada cuenca.</p><div class="grid2" style="margin-top:16px"><div class="side-card"><h4>1 · Observación</h4><p>Caudal horario/diario del IDEAM y precipitación observada. Cada dato conserva su origen.</p></div><div class="side-card"><h4>2 · Pronóstico</h4><p>Precipitación horaria futura para Santa Marta y puntos de referencia de las cuencas. La señal alimenta la ventana esperada de respuesta.</p></div><div class="side-card"><h4>3 · Respuesta</h4><p>Estimaremos el rezago lluvia→caudal a partir de eventos históricos, no con una constante arbitraria.</p></div><div class="side-card"><h4>4 · Comunicación</h4><p>La página dirá “posible incremento”, “estable” o “posible descenso”, con nivel de confianza, nunca como alerta oficial.</p></div></div></div></section>`;
  $('#metodologia-page').innerHTML=html;
  document.querySelectorAll('.page-section').forEach(p=>p.classList.remove('active')); $('#metodologia-page').classList.add('active');
}

function demoMode(){
  weatherState=null; liveHydro={}; updateUI();
  $('#weatherSource').textContent='Modo demostración';
  $('#updatedAt').textContent='Actualización: demo';
  console.info('Modo demostración activado.');
}

async function refresh(){
  $('#refreshBtn').textContent='Actualizando…';
  try{
    try{ await fetchLocalSnapshot(); }catch(e){ console.info('Sin snapshot local; usando fuentes en vivo.',e); }
    try{ await fetchWeather(); }catch(e){ console.info('Open-Meteo no disponible; manteniendo snapshot.',e); }
    try{
      const live=await fetchHydrology();
      if(Object.keys(live).length) liveHydro={...liveHydro,...live};
    }catch(e){ console.info('IDEAM no disponible en el navegador; manteniendo snapshot.',e); }
    updateUI();
  }catch(err){
    console.warn(err);
    updateUI();
  } finally {
    $('#refreshBtn').textContent='↻ Actualizar';
  }
}

$('#refreshBtn').addEventListener('click',refresh);
$('#demoBtn').addEventListener('click',demoMode);
$('#riverSelect').addEventListener('change',e=>updateChart(e.target.value));

function renderMapFallback(message) {
  const mapNode = document.getElementById('map');
  if (!mapNode) return;
  mapNode.innerHTML = `
    <div class="map-fallback">
      <div class="map-fallback-title">Mapa de Santa Marta</div>
      <p>${message}</p>
      <div class="map-fallback-river river-a">Río Manzanares</div>
      <div class="map-fallback-river river-b">Río Gaira</div>
      <div class="map-fallback-river river-c">Río Guachaca</div>
      <div class="map-fallback-note">Vista esquemática de respaldo · al recuperar la conexión se carga el mapa cartográfico.</div>
    </div>`;
}

function startApp() {
  // Ensure the dashboard is visible even if an external library is unavailable.
  document.getElementById('inicio')?.classList.add('active');

  try {
    if (!window.L) throw new Error('No se pudo cargar Leaflet. Comprueba tu conexión a internet.');
    initMap();
  } catch (error) {
    console.error('Error al iniciar el mapa:', error);
    renderMapFallback(error instanceof Error ? error.message : 'No se pudo cargar el mapa.');
  }

  try {
    updateUI();
  } catch (error) {
    console.error('Error al actualizar el tablero:', error);
    const title = document.getElementById('signalTitle');
    const copy = document.getElementById('signalCopy');
    if (title) title.textContent = 'Tablero disponible en modo básico';
    if (copy) copy.textContent = 'Algún servicio externo no respondió. El tablero y las cifras de demostración permanecen visibles.';
  }

  refresh();
}

startApp();
