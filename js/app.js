const MIN_PER_TURN = 30;
const PALETTE = ["#0d7f8f","#7b3fa0","#c8781a","#c0246b","#2f7d32","#1f5fbf","#8a5a2b","#b4243c"];
const PACE_MIN = 150, PACE_MAX = 900;            /* sane goal paces, seconds per km: 2:30 to 15:00 */

const $ = s => document.querySelector(s);
const clamp = (v,a,b) => v<a?a:v>b?b:v;
const pad2 = n => String(n).padStart(2,"0");

/* ---------- time helpers (minutes since midnight, float) ---------- */
function hhmm(min){
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min/60), m = Math.floor(min%60);
  return pad2(h) + ":" + pad2(m);
}
function dur(sec){
  const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s = Math.floor(sec%60);
  return h + ":" + pad2(m) + ":" + pad2(s);
}
function paceStr(secPerKm){
  const m = Math.floor(secPerKm/60), s = Math.round(secPerKm%60);
  return (s===60 ? m+1+":00" : m + ":" + pad2(s));
}
function parseClock(v){                      // "6:30" | "06:30" -> minutes
  const m = /^(\d{1,2}):(\d{2})$/.exec((v||"").trim());
  return m ? (+m[1])*60 + (+m[2]) : null;
}
function parseDur(v){                        // "3:45" | "3:45:30" -> seconds
  const p = (v||"").trim().split(":").map(Number);
  if (p.some(isNaN) || !p.length) return null;
  if (p.length === 2) return p[0]*3600 + p[1]*60;
  if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  return null;
}
function parsePace(v){                       // "5:20" -> sec per km
  const m = /^(\d{1,2}):(\d{2})$/.exec((v||"").trim());
  return m ? (+m[1])*60 + (+m[2]) : null;
}
/* the race clock is the phone's own clock - spectators are standing in the race's time zone */
function nowParts(){
  const n = new Date();
  return { min: n.getHours()*60 + n.getMinutes() + n.getSeconds()/60,
           ymd: n.getFullYear() + "-" + pad2(n.getMonth()+1) + "-" + pad2(n.getDate()) };
}
const nowMin = () => nowParts().min;
/* time-of-day alone is not enough: on any other day "now" is a clock reading
   that has nothing to do with the race */
const isRaceDay = () => !!(course && course.date && nowParts().ymd === course.date);
function dateLabel(ymd){
  if (!ymd) return "";
  return new Date(ymd + "T12:00:00").toLocaleDateString(undefined, {weekday:"short", day:"numeric", month:"short", year:"numeric"});
}

/* ---------- course geometry ---------- */
let course = null, PTS = [], CUM = [], TOTAL = 42195;
const KM = () => TOTAL/1000;
function setCourse(c){
  course = c;
  PTS = c ? c.pts : []; CUM = c ? courseCum(c) : [];
  TOTAL = c ? c.dist : 42195;
}
/* [lon, lat] at a distance along the course */
function posAt(d){
  d = clamp(d, 0, TOTAL);
  let lo = 0, hi = CUM.length - 1;
  while (lo < hi - 1){ const mid = (lo+hi) >> 1; if (CUM[mid] <= d) lo = mid; else hi = mid; }
  const seg = CUM[hi] - CUM[lo], t = seg > 0 ? (d - CUM[lo]) / seg : 0;
  return [PTS[lo][0] + (PTS[hi][0]-PTS[lo][0])*t, PTS[lo][1] + (PTS[hi][1]-PTS[lo][1])*t];
}
/* nearest point on the course to a screen point -> distance along, and the miss in screen px */
function nearestDist(px, py){
  const P = PTS.map(p => map.project(p));
  let best = Infinity, bd = 0;
  for (let i = 0; i < P.length - 1; i++){
    const ax = P[i].x, ay = P[i].y, bx = P[i+1].x, by = P[i+1].y;
    const dx = bx-ax, dy = by-ay, n2 = dx*dx + dy*dy;
    const t = n2 ? clamp(((px-ax)*dx + (py-ay)*dy)/n2, 0, 1) : 0;
    const qx = ax + t*dx, qy = ay + t*dy;
    const dd = (px-qx)*(px-qx) + (py-qy)*(py-qy);
    if (dd < best){ best = dd; bd = CUM[i] + (CUM[i+1]-CUM[i])*t; }
  }
  return { d: bd, err: Math.sqrt(best) };
}

/* ---------- runner model ---------- */
const effStart = r => r.aStart != null ? r.aStart : r.start;
const effGoal  = r => r.aGoal  != null ? r.aGoal  : r.goal;
const speedOf  = r => TOTAL / effGoal(r);                 // m per second
function distAt(r, tMin){
  return clamp((tMin - effStart(r)) * 60 * speedOf(r), 0, TOTAL);
}
function statusOf(r, tMin){
  if (tMin < effStart(r)) return "wait";
  if (distAt(r, tMin) >= TOTAL - 0.5) return "done";
  return "run";
}
const finishMin = r => effStart(r) + effGoal(r)/60;
/* clock time at which runner r reaches distance d */
const timeAtDist = (r, d) => effStart(r) + (d / speedOf(r)) / 60;
const goalOk = g => g >= KM()*PACE_MIN && g <= KM()*PACE_MAX;
function initials(name){
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  return (p.length === 1 ? p[0].slice(0,2) : p[0][0] + p[p.length-1][0]).toUpperCase();
}

/* ---------- state ---------- */
const KEY = "rs.runners.v1", CKEY = "rs.course.v1";
let runners = [], t = 6*60 + 30, live = false, selected = null, pin = null;

function load(){
  try{
    const raw = localStorage.getItem(KEY);
    if (raw){
      const d = JSON.parse(raw);
      if (Array.isArray(d.runners)) return d.runners.map(normalise).filter(Boolean);
    }
  }catch(e){}
  return null;
}
function save(){
  try{ localStorage.setItem(KEY, JSON.stringify({runners})); }catch(e){}
}
function loadCourse(){
  try{ return normaliseCourse(JSON.parse(localStorage.getItem(CKEY) || "null")); }catch(e){ return null; }
}
function saveCourse(){
  try{ localStorage.setItem(CKEY, JSON.stringify(course)); }catch(e){}
}
/* a runner from storage or a pasted code is untrusted input - rebuild it field by field */
function normalise(a, i){
  const name = String(a && a.name || "Runner").slice(0, 40);
  const goal = Number(a && a.goal), start = Number(a && a.start);
  if (!isFinite(goal) || goal < 60 || goal > 48*3600 || !isFinite(start) || start < 0 || start >= 1440) return null;
  /* Number(null) is 0 and isFinite(0) is true, so "no actual time recorded" must be
     tested for explicitly - coercing it would read as a midnight start and an
     infinite pace, and every runner would render as already finished. */
  const opt = (v, lo, hi) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return (isFinite(n) && n >= lo && n <= hi) ? n : null;
  };
  return {
    id: String(a.id || ("s"+i)), name, ini: initials(name),
    colour: /^#[0-9a-f]{6}$/i.test(a.colour) ? a.colour : PALETTE[i % PALETTE.length],
    start, goal,
    aStart: opt(a.aStart, 1, 1439),          /* a real crossing time, never midnight */
    aGoal:  opt(a.aGoal, 60, 48*3600)
  };
}

/* ---------- map ---------- */
const DARK = matchMedia("(prefers-color-scheme: dark)");
const styleUrl = () => "https://tiles.openfreemap.org/styles/" + (DARK.matches ? "dark" : "positron");
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const FIT_PAD = 36;

function courseBounds(){
  const b = new maplibregl.LngLatBounds(PTS[0], PTS[0]);
  PTS.forEach(p => b.extend(p));
  return b;
}

let restored = null;
try{ restored = JSON.parse(sessionStorage.getItem("rs.view") || "null"); }catch(e){}
setCourse(loadCourse());

const mapOpts = {
  container:"map", style:styleUrl(), attributionControl:{compact:true},
  dragRotate:false, pitchWithRotate:false, touchPitch:false,
};
const restoredView = !!(restored && restored.center && isFinite(restored.zoom));
if (restoredView){ mapOpts.center = restored.center; mapOpts.zoom = restored.zoom; }
else { mapOpts.center = [10, 25]; mapOpts.zoom = 1.3; }      /* the course is fitted once the panel has its height */
const map = new maplibregl.Map(mapOpts);
map.touchZoomRotate.disableRotation();
/* start the attribution folded to its (i) button - expanded it covers the bottom of a phone screen */
map.once("idle", () => {
  const a = document.querySelector(".maplibregl-ctrl-attrib");
  if (a) a.classList.remove("maplibregl-compact-show");
});

/* the course line sits under the map's labels so street names stay readable.
   isStyleLoaded() is still false while style.load fires, so track readiness ourselves. */
let styleReady = false;
function drawCourse(){
  if (!styleReady) return;
  const data = {type:"FeatureCollection", features: PTS.length
    ? [{type:"Feature", properties:{}, geometry:{type:"LineString", coordinates:PTS}}] : []};
  const src = map.getSource("course");
  if (src){ src.setData(data); return; }
  /* above every road, water and building layer, below the labels that follow them -
     some styles slip a label in early, so "before the first label" is not enough */
  const layers = map.getStyle().layers;
  let lastShape = -1;
  layers.forEach((l, i) => { if (l.type !== "symbol") lastShape = i; });
  const before = layers[lastShape + 1] ? layers[lastShape + 1].id : undefined;
  map.addSource("course", {type:"geojson", data});
  map.addLayer({id:"course-halo", type:"line", source:"course", layout:{"line-join":"round","line-cap":"round"},
    paint:{"line-color":cssVar("--ground"), "line-width":["interpolate",["linear"],["zoom"],10,6,15,12], "line-opacity":.85}}, before);
  map.addLayer({id:"course-line", type:"line", source:"course", layout:{"line-join":"round","line-cap":"round"},
    paint:{"line-color":cssVar("--course"), "line-width":["interpolate",["linear"],["zoom"],10,3,15,6]}}, before);
}
map.on("style.load", () => { styleReady = true; drawCourse(); });
DARK.addEventListener("change", () => {                /* style.load re-adds the course */
  styleReady = false; map.setStyle(styleUrl(), {diff:false});
});
map.on("move", () => { renderOverlay(); saveView(); });
map.on("resize", renderOverlay);

function fitCourse(animate){
  if (course) map.fitBounds(courseBounds(), {padding:FIT_PAD, duration: animate ? 600 : 0});
}

/* ---------- overlay: km markers, pin and runners, drawn in screen pixels ---------- */
const svgOverlay = $("#overlay");
function inView(p, m){
  const w = svgOverlay.clientWidth, h = svgOverlay.clientHeight;
  return p.x > -m && p.y > -m && p.x < w+m && p.y < h+m;
}
function renderKm(){
  if (!course){ $("#gKm").innerHTML = ""; return; }
  /* show every km once they are far enough apart on screen to read */
  const lat = PTS[0][1]*Math.PI/180;
  const kmPx = 1000 / (40075016.686*Math.cos(lat) / (512*Math.pow(2, map.getZoom())));
  const step = kmPx >= 30 ? 1000 : kmPx*5 >= 30 ? 5000 : 10000;
  const out = [];
  for (let d = step; d < TOTAL - 1; d += step){
    const p = map.project(posAt(d));
    if (!inView(p, 20)) continue;
    const minor = d % 5000 !== 0;
    out.push('<g transform="translate('+p.x.toFixed(1)+','+p.y.toFixed(1)+')" opacity="'+(minor?0.75:1)+'">'
      + '<circle class="kmdot" r="'+(minor?6:8)+'"></circle>'
      + '<text class="kmtxt" y="0.5" font-size="'+(minor?7:8.5)+'">'+(d/1000)+'</text></g>');
  }
  $("#gKm").innerHTML = out.join("");
}
function renderRunners(){
  if (!course){ $("#gRunners").innerHTML = ""; return; }
  const items = runners.map(r => {
    const d = distAt(r, t), p = map.project(posAt(d));
    return { r, d, x: p.x, y: p.y, sx: p.x, sy: p.y, st: statusOf(r, t) };
  });
  /* nudge overlapping markers apart so bunched runners stay readable */
  for (let pass = 0; pass < 6; pass++){
    for (let i = 0; i < items.length; i++)
      for (let j = i+1; j < items.length; j++){
        const a = items[i], b = items[j];
        let dx = b.sx-a.sx, dy = b.sy-a.sy;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.001){ dx = 0; dy = 1; dist = 1; }
        const need = 31;
        if (dist < need){
          const push = (need-dist)/2/dist;
          a.sx -= dx*push; a.sy -= dy*push;
          b.sx += dx*push; b.sy += dy*push;
        }
      }
  }
  $("#gRunners").innerHTML = items.map(o => {
    const cls = "rm " + o.st + (selected === o.r.id ? " sel" : "");
    return '<g class="'+cls+'" data-id="'+o.r.id+'" transform="translate('+o.sx.toFixed(1)+','+o.sy.toFixed(1)+')">'
      + '<line stroke="'+o.r.colour+'" stroke-width="1.4" opacity=".5" x1="0" y1="0" x2="'
        + (o.x-o.sx).toFixed(1)+'" y2="'+(o.y-o.sy).toFixed(1)+'"></line>'
      + '<circle class="halo" r="19"></circle>'
      + '<circle class="ring" r="13" fill="'+o.r.colour+'"></circle>'
      + '<text class="ini">'+o.r.ini+'</text></g>';
  }).join("");
}
function renderPin(){
  if (pin == null || !course){ $("#gPin").innerHTML = ""; return; }
  const p = map.project(posAt(pin));
  $("#gPin").innerHTML = '<g transform="translate('+p.x.toFixed(1)+','+p.y.toFixed(1)+')">'
    + '<circle class="pin" r="6"></circle><circle class="pin" r="13" fill="none" opacity=".45"></circle></g>';
}
function renderOverlay(){ renderKm(); renderPin(); renderRunners(); }

/* ---------- panel ---------- */
function renderPanel(){
  const list = $("#rlist");
  if (!runners.length){
    list.innerHTML = '<div class="empty">No runners yet.<br>Add one with their start time and goal finish.</div>';
    return;
  }
  list.innerHTML = runners.slice().sort((a,b)=>distAt(b,t)-distAt(a,t)).map(r => {
    const d = distAt(r,t), st = statusOf(r,t), pct = d/TOTAL*100;
    const meta = st === "wait" ? "Starts " + hhmm(effStart(r))
      : st === "done" ? "Finished " + hhmm(finishMin(r))
      : paceStr(effGoal(r)/KM()) + "/km &middot; finish " + hhmm(finishMin(r));
    return '<div class="rcard'+(selected===r.id?" sel":"")+'" data-id="'+r.id+'">'
      + '<div class="chip" style="background:'+r.colour+'">'+r.ini+'</div>'
      + '<div><div class="rname">'+esc(r.name)+'</div><div class="rmeta">'+meta+'</div></div>'
      + '<div class="rdist">'+(d/1000).toFixed(1)+'<small>km</small></div>'
      + '<div class="bar"><i style="width:'+pct.toFixed(1)+'%;background:'+r.colour+'"></i></div>'
      + '</div>';
  }).join("");
}
function esc(s){ return String(s).replace(/[&<>"']/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

/* ---------- clock ---------- */
function renderClock(){
  $("#clock").textContent = hhmm(t);
  const running = runners.filter(r => statusOf(r,t) === "run").length;
  const waiting = runners.filter(r => statusOf(r,t) === "wait").length;
  $("#clocksub").textContent = !runners.length ? "Add your runners"
    : running ? running + " on course" + (waiting ? " · " + waiting + " to start" : "")
    : waiting ? waiting + " still to start" : "all finished";
  $("#nowBtn").dataset.live = live ? "1" : "0";
}
function renderAll(){ renderOverlay(); renderPanel(); renderClock(); }

/* ---------- race header, upload prompt, Now button ---------- */
function renderRace(){
  $("#raceLine").textContent = course
    ? [course.name, dateLabel(course.date), distLabel(course.dist)].filter(Boolean).join(" · ")
    : "Upload a course to start";
  document.title = course ? course.name + " · Race Spectator" : "Race Spectator";
  $("#emptyCourse").hidden = !!course;
  $("#dialwrap").hidden = !course;
  $("#hint").hidden = !course;
  const raceDay = isRaceDay();
  $("#nowBtn").disabled = !raceDay;
  $("#nowBtn").title = raceDay ? "Follow the live race clock"
    : course && course.date ? "The live clock starts on race day, " + dateLabel(course.date)
    : "Set the race date to use the live clock";
  if (!raceDay) live = false;
}

/* ---------- bezel ---------- */
(function buildTicks(){
  /* 12 ticks, one every 2.5 minutes; the quarters are a touch heavier */
  let s = "";
  for (let i = 0; i < 12; i++){
    const a = i*Math.PI/6, r1 = 84.5, r2 = 91;
    s += '<line class="tick" stroke-width="'+(i % 3 ? 1.2 : 1.8)+'"'
      + ' x1="'+(100+Math.sin(a)*r1).toFixed(2)+'" y1="'+(100-Math.cos(a)*r1).toFixed(2)+'"'
      + ' x2="'+(100+Math.sin(a)*r2).toFixed(2)+'" y2="'+(100-Math.cos(a)*r2).toFixed(2)+'"></line>';
  }
  $("#ticks").innerHTML = s;
})();

const dial = $("#dialwrap"), ticksG = $("#ticks"), grab = $("#grab"), stage = $("#stage");
let vel = 0, coasting = null, lastWhole = Math.floor(t), timeTouched = false;
/* the bezel turns from half an hour before the first start to half an hour after the last finish */
function timeWindow(){
  if (!runners.length) return [5*60, 15*60];
  const s = Math.min(...runners.map(effStart)), f = Math.max(...runners.map(finishMin));
  return [Math.max(0, Math.floor(s/30)*30 - 30), Math.min(1439, Math.ceil(f/30)*30 + 30)];
}
/* where to sit when we are not tracking live: just as the first wave goes */
function defaultTime(){
  return runners.length ? Math.min(...runners.map(effStart)) : 6*60 + 30;
}

/* only the ticks turn - the rim highlight stays put, like light on real glass */
function spinTicks(){
  const a = t*360/MIN_PER_TURN;
  ticksG.setAttribute("transform","rotate("+a.toFixed(2)+" 100 100)");
}
function setTime(v, fromLive){
  const [lo, hi] = timeWindow();
  t = clamp(v, lo, hi);
  if (!fromLive) live = false;
  const w = Math.floor(t);
  if (w !== lastWhole){
    lastWhole = w;
    if (dragging && navigator.vibrate){ try{ navigator.vibrate(6); }catch(e){} }   /* a tick under the finger */
  }
  spinTicks(); renderAll(); saveView();
}

let dragging = false, lastA = 0;
const angleAt = e => {
  const r = dial.getBoundingClientRect();
  return Math.atan2(e.clientY - (r.top + r.height/2), e.clientX - (r.left + r.width/2));
};
grab.addEventListener("pointerdown", e => {
  dragging = true; lastA = angleAt(e); vel = 0; timeTouched = true;
  if (coasting) cancelAnimationFrame(coasting);
  dial.classList.add("drag");
  try{ grab.setPointerCapture(e.pointerId); }catch(_){}
  $("#hint").classList.add("gone");
  e.preventDefault(); e.stopPropagation();
});
grab.addEventListener("pointermove", e => {
  if (!dragging) return;
  e.stopPropagation();
  const a = angleAt(e);
  let d = a - lastA;
  if (d >  Math.PI) d -= 2*Math.PI;
  if (d < -Math.PI) d += 2*Math.PI;
  lastA = a;
  const dm = d/(2*Math.PI)*MIN_PER_TURN;
  vel = vel*0.7 + dm*0.3;
  setTime(t + dm);
});
function endDrag(e){
  if (!dragging) return;
  dragging = false; dial.classList.remove("drag");
  if (e) e.stopPropagation();
  const coast = () => {
    if (Math.abs(vel) < 0.004) return;
    setTime(t + vel); vel *= 0.93;
    coasting = requestAnimationFrame(coast);
  };
  coast();
}
grab.addEventListener("pointerup", endDrag);
grab.addEventListener("pointercancel", endDrag);
grab.addEventListener("keydown", e => {
  const step = e.shiftKey ? 5 : 1;
  if (e.key === "ArrowRight" || e.key === "ArrowUp"){ timeTouched = true; setTime(t+step); e.preventDefault(); }
  if (e.key === "ArrowLeft"  || e.key === "ArrowDown"){ timeTouched = true; setTime(t-step); e.preventDefault(); }
});

$("#nowBtn").addEventListener("click", e => {
  e.stopPropagation(); timeTouched = true; live = true; setTime(nowMin(), true);
});
setInterval(() => { if (live && !dragging && isRaceDay()) setTime(nowMin(), true); }, 1000);

/* ---------- zoom buttons ---------- */
$("#zIn").addEventListener("click", () => map.zoomIn());
$("#zOut").addEventListener("click", () => map.zoomOut());
$("#zFit").addEventListener("click", () => fitCourse(true));

/* ---------- selection & course tap ---------- */
svgOverlay.addEventListener("click", e => {
  const rm = e.target.closest(".rm");
  if (!rm) return;
  selected = rm.dataset.id; renderAll(); openDetail(selected);
});
map.on("click", e => {
  if (!course) return;
  const hit = nearestDist(e.point.x, e.point.y);
  if (hit.err > 26){ pin = null; selected = null; renderAll(); return; }
  pin = hit.d; renderAll(); openPasses(hit.d);
});
$("#rlist").addEventListener("click", e => {
  const c = e.target.closest(".rcard");
  if (!c) return;
  selected = c.dataset.id;
  const r = runners.find(x => x.id === selected);
  /* bring the runner into view if they are off to the side, without changing the zoom */
  if (r && course){
    const ll = posAt(distAt(r, t)), p = map.project(ll);
    const w = svgOverlay.clientWidth, h = svgOverlay.clientHeight;
    if (p.x < w*.15 || p.x > w*.85 || p.y < h*.15 || p.y > h*.85) map.easeTo({center: ll, duration: 500});
  }
  renderAll(); openDetail(selected);
});

/* ---------- modal ---------- */
const scrim = $("#scrim"), modal = $("#modal");
function openModal(html){ modal.innerHTML = html; scrim.classList.add("open"); }
function closeModal(){ scrim.classList.remove("open"); modal.innerHTML = ""; }
scrim.addEventListener("click", e => { if (e.target === scrim) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

/* ---------- add / edit ---------- */
function openEdit(id){
  const r = runners.find(x => x.id === id);
  const isNew = !r;
  const last = runners[runners.length - 1];
  const cur = r || {name:"", start: last ? last.start : 7*60, goal: Math.round(KM()*360/60)*60,
                    colour:PALETTE[runners.length % PALETTE.length], aStart:null, aGoal:null};
  let mode = "goal", colour = cur.colour;

  openModal(
    '<h3>'+(isNew?"Add a runner":"Edit runner")+'</h3>'
  + '<p class="sub">Give them a start time and either a goal finish or a pace &mdash; whichever you actually know.</p>'
  + '<div class="field"><label for="f-name">Name</label><input id="f-name" value="'+esc(cur.name)+'" placeholder="e.g. Ash Mehta" autocomplete="off"></div>'
  + '<div class="two">'
    + '<div class="field"><label for="f-start">Start time</label><input id="f-start" type="time" value="'+hhmm(cur.start)+'"></div>'
    + '<div class="field"><label>Colour</label><div class="swatches" id="f-sw">'
      + PALETTE.map(c => '<button type="button" data-c="'+c+'" style="background:'+c+'" aria-pressed="'+(c===colour)+'" aria-label="colour"></button>').join("")
      + '</div></div>'
  + '</div>'
  + '<div class="field"><label>Predict by</label><div class="seg" id="f-seg">'
    + '<button type="button" data-m="goal" aria-pressed="true">Goal finish</button>'
    + '<button type="button" data-m="pace" aria-pressed="false">Pace</button></div></div>'
  + '<div class="field" id="f-goalwrap"><label for="f-goal">Goal finish time</label>'
    + '<input id="f-goal" inputmode="numeric" placeholder="3:45" value="'+dur(cur.goal).replace(/:00$/,"")+'">'
    + '<div class="note">Hours:minutes, e.g. <b>3:45</b> or <b>0:52</b></div></div>'
  + '<div class="field" id="f-pacewrap" style="display:none"><label for="f-pace">Average pace</label>'
    + '<input id="f-pace" inputmode="numeric" placeholder="5:20" value="'+paceStr(cur.goal/KM())+'">'
    + '<div class="note">Minutes per km, e.g. <b>5:20</b></div></div>'
  + (isNew ? "" :
      '<div class="field" style="border-top:1px solid var(--line);padding-top:14px;margin-top:4px">'
    + '<label>Actual, once you know it</label>'
    + '<div class="note" style="margin-bottom:8px">Overrides the prediction. Leave blank to keep using the plan above.</div>'
    + '<div class="two">'
      + '<div class="field" style="margin:0"><label for="f-astart">Real start</label>'
        + '<input id="f-astart" type="time" value="'+(cur.aStart!=null?hhmm(cur.aStart):"")+'"></div>'
      + '<div class="field" style="margin:0"><label for="f-apace">Real pace</label>'
        + '<input id="f-apace" inputmode="numeric" placeholder="5:20" value="'+(cur.aGoal!=null?paceStr(cur.aGoal/KM()):"")+'"></div>'
    + '</div></div>')
  + '<div class="actions"><button class="tbtn" id="f-cancel" style="flex:0 0 auto">Cancel</button>'
    + '<button class="tbtn primary" id="f-save">'+(isNew?"Add runner":"Save")+'</button></div>'
  + (isNew ? "" : '<button class="danger" id="f-del">Remove '+esc(cur.name)+'</button>')
  );

  $("#f-sw").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    colour = b.dataset.c;
    [...$("#f-sw").children].forEach(x => x.setAttribute("aria-pressed", x === b));
  });
  $("#f-seg").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    mode = b.dataset.m;
    [...$("#f-seg").children].forEach(x => x.setAttribute("aria-pressed", x === b));
    $("#f-goalwrap").style.display = mode === "goal" ? "" : "none";
    $("#f-pacewrap").style.display = mode === "pace" ? "" : "none";
  });
  $("#f-cancel").addEventListener("click", closeModal);
  if (!isNew) $("#f-del").addEventListener("click", () => {
    runners = runners.filter(x => x.id !== id);
    if (selected === id) selected = null;
    save(); closeModal(); renderAll();
  });

  $("#f-save").addEventListener("click", () => {
    const name = $("#f-name").value.trim() || "Runner";
    const start = parseClock($("#f-start").value);
    let goal = mode === "goal" ? parseDur($("#f-goal").value)
                               : (parsePace($("#f-pace").value) || 0) * KM();
    if (start == null){ flag("#f-start", "Needs a start time"); return; }
    if (!goal || !goalOk(goal)){
      flag(mode==="goal" ? "#f-goal" : "#f-pace",
           mode==="goal" ? "That’s outside a 2:30–15:00 /km pace for this distance"
                         : "Use minutes per km between 2:30 and 15:00"); return;
    }
    let aStart = null, aGoal = null;
    if (!isNew){
      aStart = parseClock($("#f-astart").value);
      const ap = parsePace($("#f-apace").value);
      if (ap && goalOk(ap * KM())) aGoal = ap * KM();
    }
    if (isNew){
      runners.push({id: "r"+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36),
        name, ini: initials(name), colour, start, goal: Math.round(goal), aStart, aGoal});
    } else {
      Object.assign(r, {name, ini: initials(name), colour, start, goal: Math.round(goal),
        aStart, aGoal: aGoal != null ? Math.round(aGoal) : null});
    }
    save(); closeModal(); setTime(t);
  });
}
function flag(sel, msg){
  const el = $(sel); el.style.borderColor = "#c0392b"; el.focus();
  let n = el.parentNode.querySelector(".note");
  if (!n){ n = document.createElement("div"); n.className = "note"; el.parentNode.appendChild(n); }
  n.textContent = msg; n.style.color = "#c0392b";
}

/* ---------- runner detail ---------- */
function openDetail(id){
  const r = runners.find(x => x.id === id); if (!r) return;
  const d = distAt(r, t), st = statusOf(r, t), pace = effGoal(r)/KM();
  const label = {run:"On course", wait:"Not started", done:"Finished"}[st];
  const step = TOTAL > 15000 ? 5000 : 1000, marks = [];
  for (let m = step; m < TOTAL - 1; m += step) marks.push(m);
  marks.push(TOTAL);
  const nextIdx = marks.findIndex(m => m > d);

  openModal(
    '<h3 style="display:flex;align-items:center;gap:9px">'
      + '<span class="chip" style="background:'+r.colour+'">'+r.ini+'</span>'+esc(r.name)+'</h3>'
  + '<p class="sub"><span class="pill '+st+'">'+label+'</span> '
      + (r.aStart!=null||r.aGoal!=null ? '&nbsp;<span class="pill done">Actual data</span>' : '')+'</p>'
  + '<div class="statline">'
    + '<div class="stat"><span>Distance</span><b>'+(d/1000).toFixed(2)+' km</b></div>'
    + '<div class="stat"><span>Pace</span><b>'+paceStr(pace)+'</b></div>'
    + '<div class="stat"><span>Finishes</span><b>'+hhmm(finishMin(r))+'</b></div>'
  + '</div>'
  + '<div class="field"><label>Where they should be, when</label><div class="splits">'
    + marks.map((m,i) => {
        const past = m <= d;
        const cls = past ? "past" : (i === nextIdx ? "next" : "");
        const km = m === TOTAL ? "Finish" : (m/1000)+" km";
        return '<div class="split '+cls+'"><span class="lbl">'+km+'</span>'
          + '<span>'+(past ? "passed" : (i===nextIdx ? "next" : ""))+'</span>'
          + '<b>'+hhmm(timeAtDist(r, m))+'</b></div>';
      }).join("")
    + '</div></div>'
  + '<div class="actions"><button class="tbtn" id="d-close" style="flex:0 0 auto">Close</button>'
    + '<button class="tbtn primary" id="d-edit">Edit &amp; set actuals</button></div>'
  );
  $("#d-close").addEventListener("click", closeModal);
  $("#d-edit").addEventListener("click", () => openEdit(id));
}

/* ---------- who passes here ---------- */
function openPasses(d){
  const rows = runners.map(r => ({r, at: timeAtDist(r, d)})).sort((a,b) => a.at - b.at);
  openModal(
    '<h3>'+(d/1000).toFixed(1)+' km point</h3>'
  + '<p class="sub">When each runner reaches this spot.</p>'
  + (rows.length
      ? '<div class="splits">' + rows.map(o => {
          const past = o.at < t;
          return '<div class="split'+(past?" past":"")+'">'
            + '<span class="chip" style="width:24px;height:24px;font-size:9.5px;background:'+o.r.colour+'">'+o.r.ini+'</span>'
            + '<span>'+esc(o.r.name)+(past?' <span class="lbl">gone</span>':'')+'</span>'
            + '<b>'+hhmm(o.at)+'</b></div>';
        }).join("") + '</div>'
      : '<div class="empty">Add a runner to see pass times.</div>')
  + '<div class="actions"><button class="tbtn" id="p-clear" style="flex:0 0 auto">Clear pin</button>'
    + '<button class="tbtn primary" id="p-close">Done</button></div>'
  );
  $("#p-close").addEventListener("click", closeModal);
  $("#p-clear").addEventListener("click", () => { pin = null; renderAll(); closeModal(); });
}

/* ---------- course: upload and race details ---------- */
const fileInput = $("#gpxFile");
function pickGpx(){ fileInput.value = ""; fileInput.click(); }
async function readGpx(file){
  /* with no course yet the upload prompt is on screen, so the error goes there */
  const err = msg => {
    if (!course){ $("#gpxErr").textContent = msg; return; }
    openModal('<h3>Couldn’t use that file</h3><p class="sub">'+esc(msg)+'</p>'
      + '<div class="actions"><button class="tbtn primary" id="e-ok">OK</button></div>');
    $("#e-ok").addEventListener("click", closeModal);
  };
  if (!file) return;
  if (file.size > 25*1024*1024) return err("That file is over 25 MB - is it a GPX?");
  try{ openRace(parseGpx(await file.text(), file.name), true); }
  catch(e){ err(e.message || "That file couldn’t be read."); }
}
fileInput.addEventListener("change", () => readGpx(fileInput.files[0]));
$("#pickGpx").addEventListener("click", pickGpx);

stage.addEventListener("dragover", e => { e.preventDefault(); stage.classList.add("dropping"); });
stage.addEventListener("dragleave", e => { if (e.target === stage || !stage.contains(e.relatedTarget)) stage.classList.remove("dropping"); });
stage.addEventListener("drop", e => {
  e.preventDefault(); stage.classList.remove("dropping");
  readGpx(e.dataTransfer.files && e.dataTransfer.files[0]);
});

/* race details - shown straight after an upload, and from the Course button */
function openRace(c, isNew){
  const opts = STANDARD_DISTANCES.slice();
  const own = isNew ? Math.round(c.measured/10)*10 : c.dist;     /* the GPX length, or a custom distance saved earlier */
  if (!opts.some(o => o.m === own))
    opts.push({m: own, label: (isNew ? "As measured – " : "") + (own/1000).toFixed(2) + " km"});
  openModal(
    '<h3>'+(isNew ? "Race details" : "Course")+'</h3>'
  + '<p class="sub">'+(isNew
      ? "Your GPX measures " + (c.measured/1000).toFixed(2) + " km. Pick the official distance so pace and splits line up with the race."
      : "Runner positions are spread along the course by the official distance.")+'</p>'
  + '<div class="field"><label for="r-name">Race name</label><input id="r-name" value="'+esc(c.name)+'" autocomplete="off"></div>'
  + '<div class="two">'
    + '<div class="field"><label for="r-date">Race date</label><input id="r-date" type="date" value="'+esc(c.date)+'"></div>'
    + '<div class="field"><label for="r-dist">Distance</label><select id="r-dist">'
      + opts.map(o => '<option value="'+o.m+'"'+(o.m === c.dist ? " selected" : "")+'>'+esc(o.label)+'</option>').join("")
      + '</select></div>'
  + '</div>'
  + '<div class="field"><div class="note">The live clock uses this phone’s time zone and switches on for the race date.</div></div>'
  + '<div class="actions"><button class="tbtn" id="r-cancel" style="flex:0 0 auto">Cancel</button>'
    + '<button class="tbtn primary" id="r-save">'+(isNew ? "Use this course" : "Save")+'</button></div>'
  + (isNew ? "" : '<button class="danger" id="r-new" style="color:var(--accent)">Load a different GPX</button>')
  );
  $("#r-cancel").addEventListener("click", closeModal);
  if (!isNew) $("#r-new").addEventListener("click", () => { closeModal(); pickGpx(); });
  $("#r-save").addEventListener("click", () => {
    const next = normaliseCourse({v:1, pts:c.pts, name: $("#r-name").value.trim() || "My race",
                                  date: $("#r-date").value, dist: Number($("#r-dist").value)});
    if (!next) return;
    setCourse(next); saveCourse();
    pin = null; selected = null;
    closeModal(); drawCourse(); renderRace();
    if (isNew){ fitCourse(true); if (!timeTouched && !live) t = defaultTime(); }
    setTime(t, live);
  });
}
$("#courseBtn").addEventListener("click", () => course ? openRace(course, false) : pickGpx());

/* ---------- crew share ----------
   Copy/paste code for now - replaced by share links (crew + course in the URL) in a later step. */
const enc = o => { const b = new TextEncoder().encode(JSON.stringify(o));
  let s = ""; b.forEach(c => s += String.fromCharCode(c)); return btoa(s); };
const dec = x => { const s = atob(x.trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(s, c => c.charCodeAt(0)))); };

function openCrew(){
  const code = enc(runners.map(r => [r.name, r.colour, r.start, r.goal, r.aStart, r.aGoal]));
  openModal(
    '<h3>Your crew</h3>'
  + '<p class="sub">Your list is kept on this device. Hand this code to someone else to give them the same runners.</p>'
  + '<div class="field"><label for="c-out">Your code</label><textarea id="c-out" readonly>'+code+'</textarea>'
    + '<button class="tbtn" id="c-copy" style="justify-content:center">Copy code</button></div>'
  + '<div class="field" style="border-top:1px solid var(--line);padding-top:14px">'
    + '<label for="c-in">Load someone else’s code</label><textarea id="c-in" placeholder="Paste a code here"></textarea>'
    + '<div class="note" id="c-msg">This replaces your current list.</div></div>'
  + '<div class="actions"><button class="tbtn" id="c-close" style="flex:0 0 auto">Close</button>'
    + '<button class="tbtn primary" id="c-load">Load crew</button></div>'
  );
  $("#c-close").addEventListener("click", closeModal);
  $("#c-copy").addEventListener("click", async () => {
    const ta = $("#c-out");
    try{ await navigator.clipboard.writeText(ta.value); }
    catch(e){ ta.select(); try{ document.execCommand("copy"); }catch(_){} }
    $("#c-copy").textContent = "Copied";
    setTimeout(() => { $("#c-copy").textContent = "Copy code"; }, 1600);
  });
  $("#c-load").addEventListener("click", () => {
    try{
      const arr = dec($("#c-in").value);
      if (!Array.isArray(arr) || !arr.length) throw 0;
      const list = arr.map((a,i) => normalise({id:"i"+i+Date.now().toString(36), name:a[0], colour:a[1],
        start:a[2], goal:a[3], aStart:a[4], aGoal:a[5]}, i)).filter(Boolean);
      if (!list.length) throw 0;
      runners = list; selected = null; save(); closeModal(); setTime(defaultTime());
    }catch(e){
      const m = $("#c-msg"); m.textContent = "That code didn’t read properly — copy it again in full."; m.style.color = "#c0392b";
    }
  });
}

/* ---------- per-viewer view state (survives a reload) ---------- */
let vTimer = null;
function saveView(){
  clearTimeout(vTimer);
  vTimer = setTimeout(() => {
    const c = map.getCenter();
    try{ sessionStorage.setItem("rs.view", JSON.stringify({t, live, center:[c.lng, c.lat], zoom:map.getZoom()})); }catch(e){}
  }, 400);
}

/* ---------- wiring & init ---------- */
$("#addBtn").addEventListener("click", () => openEdit(null));
$("#shareBtn").addEventListener("click", openCrew);
$("#clearBtn").addEventListener("click", () => {
  openModal('<h3>Clear all runners?</h3><p class="sub">This removes everyone from your list on this device.</p>'
    + '<div class="actions"><button class="tbtn" id="x-no" style="flex:0 0 auto">Keep them</button>'
    + '<button class="tbtn primary" id="x-yes">Clear all</button></div>');
  $("#x-no").addEventListener("click", closeModal);
  $("#x-yes").addEventListener("click", () => { runners = []; selected = null; pin = null; save(); closeModal(); renderAll(); });
});

runners = load() || [];
renderRace(); renderPanel();
map.resize();
if (!restoredView) fitCourse(false);
const nowM = nowMin(), [winLo, winHi] = timeWindow();
if (restored && isFinite(restored.t) && !restored.live){ timeTouched = true; setTime(restored.t); }
else if (isRaceDay() && nowM > winLo && nowM < winHi){ live = true; setTime(nowM, true); }
else setTime(defaultTime());
setTimeout(() => $("#hint").classList.add("gone"), 9000);
