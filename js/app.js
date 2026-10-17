const VB = MAP.viewBox, PTS = MAP.course.pts, CUM = MAP.course.cum;
const TOTAL = 42195, MIN_PER_TURN = 30;
const PALETTE = ["#0d7f8f","#7b3fa0","#c8781a","#c0246b","#2f7d32","#1f5fbf","#8a5a2b","#b4243c"];

const $ = s => document.querySelector(s);
const clamp = (v,a,b) => v<a?a:v>b?b:v;

/* ---------- time helpers (minutes since midnight, float) ---------- */
function hhmm(min){
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min/60), m = Math.floor(min%60);
  return String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0");
}
function dur(sec){
  const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s = Math.floor(sec%60);
  return h + ":" + String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0");
}
function paceStr(secPerKm){
  const m = Math.floor(secPerKm/60), s = Math.round(secPerKm%60);
  return (s===60 ? m+1+":00" : m + ":" + String(s).padStart(2,"0"));
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
/* Sydney is UTC+10 (AEST) on race weekend - DST does not start until October */
const RACE_YMD = 20260830;                      /* Sun 30 Aug 2026 */
function sydneyParts(){
  const n = new Date();
  const s = new Date(n.getTime() + n.getTimezoneOffset()*60000 + 10*3600000);
  return { min: s.getHours()*60 + s.getMinutes() + s.getSeconds()/60,
           ymd: s.getFullYear()*10000 + (s.getMonth()+1)*100 + s.getDate() };
}
function sydneyNowMin(){ return sydneyParts().min; }
/* time-of-day alone is not enough: on any other day "now" is a race-morning
   clock reading that has already run past everybody's finish */
function isRaceDay(){ return sydneyParts().ymd === RACE_YMD; }

/* ---------- course geometry ---------- */
function posAt(d){
  d = clamp(d, 0, TOTAL);
  let lo = 0, hi = CUM.length - 1;
  while (lo < hi - 1){ const mid = (lo+hi) >> 1; if (CUM[mid] <= d) lo = mid; else hi = mid; }
  const seg = CUM[hi] - CUM[lo], t = seg > 0 ? (d - CUM[lo]) / seg : 0;
  return [PTS[lo][0] + (PTS[hi][0]-PTS[lo][0])*t, PTS[lo][1] + (PTS[hi][1]-PTS[lo][1])*t];
}
/* nearest point on the course polyline to an arbitrary map point -> distance along */
function nearestDist(px, py){
  let best = Infinity, bd = 0;
  for (let i = 0; i < PTS.length - 1; i++){
    const [ax,ay] = PTS[i], [bx,by] = PTS[i+1];
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
function initials(name){
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  return (p.length === 1 ? p[0].slice(0,2) : p[0][0] + p[p.length-1][0]).toUpperCase();
}

/* ---------- state ---------- */
const KEY = "sms.v1";
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
/* a runner from shared storage is untrusted input - rebuild it field by field */
function normalise(a, i){
  const name = String(a && a.name || "Runner").slice(0, 40);
  const goal = Number(a && a.goal), start = Number(a && a.start);
  if (!isFinite(goal) || goal < 60 || !isFinite(start)) return null;
  /* Number(null) is 0 and isFinite(0) is true, so "no actual time recorded" must be
     tested for explicitly - coercing it would read as a midnight start and an
     infinite pace, and every runner would render as already finished. The range
     checks also heal any list already written with those zeroes in it. */
  const opt = (v, lo, hi) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return (isFinite(n) && n >= lo && n <= hi) ? n : null;
  };
  return {
    id: String(a.id || ("s"+i)), name, ini: initials(name),
    colour: /^#[0-9a-f]{6}$/i.test(a.colour) ? a.colour : PALETTE[i % PALETTE.length],
    start, goal,
    aStart: opt(a.aStart, 4*60, 15*60),      /* a real crossing time, never midnight */
    aGoal:  opt(a.aGoal, 1800, 12*3600)
  };
}
function seed(){
  return [
    {id:"a", name:"Ash Mehta",    ini:"AM", colour:PALETTE[0], start:6*60+30, goal:3*3600+25*60, aStart:null, aGoal:null},
    {id:"b", name:"Priya Raman",  ini:"PR", colour:PALETTE[1], start:6*60+50, goal:4*3600+10*60, aStart:null, aGoal:null},
    {id:"c", name:"Tom Delaney",  ini:"TD", colour:PALETTE[2], start:7*60+15, goal:4*3600+55*60, aStart:null, aGoal:null},
  ];
}

const svg = $("#map");
svg.setAttribute("viewBox", VB.join(" "));

/* ---------- static map layers ---------- */
function pathsInto(g, list, cls){
  $(g).innerHTML = list.map(d => '<path class="'+cls+'" fill-rule="evenodd" d="'+d+'"></path>').join("");
}
pathsInto("#gWater", MAP.water, "w");
pathsInto("#gParks", MAP.parks, "p");
$("#coursePath").setAttribute("d", MAP.course.d);
$("#courseHalo").setAttribute("d", MAP.course.d);

/* ---------- view (pan / zoom) ---------- */
const ASPECT = VB[3]/VB[2];
const MIN_W = VB[2]/14;                    // deepest zoom
let view = {x:0, y:0, w:VB[2], h:VB[3]};

/* viewBox units per screen pixel - markers counter-scale by this so they stay a
   constant size on screen at every zoom level */
function unitsPerPx(){
  const r = svg.getBoundingClientRect();
  const s = Math.min(r.width / view.w, r.height / view.h);
  return s > 0 ? 1/s : 1;
}
let K = 1;

function clampView(){
  view.w = clamp(view.w, MIN_W, VB[2]);
  view.h = view.w * ASPECT;
  const mx = view.w*0.18, my = view.h*0.18;
  view.x = clamp(view.x, -mx, VB[2] - view.w + mx);
  view.y = clamp(view.y, -my, VB[3] - view.h + my);
}
function applyView(){
  clampView();
  svg.setAttribute("viewBox",
    view.x.toFixed(1)+" "+view.y.toFixed(1)+" "+view.w.toFixed(1)+" "+view.h.toFixed(1));
  renderStatic(); renderRunners(); renderPin(); showZoom();
  if (typeof saveView === "function") saveView();
}
let zTimer = null;
function showZoom(){
  const z = VB[2]/view.w;
  const el = $("#zlevel");
  el.textContent = z.toFixed(1)+"×";
  el.classList.add("show");
  clearTimeout(zTimer);
  zTimer = setTimeout(() => el.classList.remove("show"), 1400);
  $("#zIn").disabled  = view.w <= MIN_W + 0.5;
  $("#zOut").disabled = view.w >= VB[2] - 0.5;
}

function renderStatic(){
  K = unitsPerPx();
  const pxPerUnit = 1/K;
  const inView = (x, y, m) => x > view.x-m && x < view.x+view.w+m && y > view.y-m && y < view.y+view.h+m;

  /* denser km markers once you are zoomed in far enough to read them */
  const step = view.w < VB[2]/4 ? 1000 : 5000;
  const km = [];
  for (let d = step; d < TOTAL; d += step){
    const [x,y] = posAt(d);
    if (!inView(x, y, view.w*0.05)) continue;
    const minor = d % 5000 !== 0;
    km.push('<g transform="translate('+x.toFixed(1)+','+y.toFixed(1)+') scale('+K.toFixed(3)+')" opacity="'+(minor?0.65:1)+'">'
      + '<circle class="kmdot" r="'+(minor?5.5:7.5)+'"></circle>'
      + '<text class="kmtxt" y="0.5" font-size="'+(minor?6.5:8)+'">'+(d/1000)+'</text></g>');
  }
  $("#gKm").innerHTML = km.join("");

  /* landmark labels: drop any that would collide with one already placed */
  const boxes = [], out = [];
  const ordered = MAP.landmarks
    .map(l => ({l, rank: l.k === "poi" ? 1 : 0}))
    .sort((a,b) => a.rank - b.rank);
  for (const {l} of ordered){
    if (!inView(l.x, l.y, view.w*0.02)) continue;
    const big = l.k !== "poi";
    const sx = l.x*pxPerUnit, sy = l.y*pxPerUnit;
    const left = l.x > view.x + view.w*0.58;
    const w = l.n.length*5.3 + 10, h = 13;
    const bx = left ? sx - 9 - w : sx + 9;
    const box = [bx, sy - h/2, bx + w, sy + h/2];
    const hit = boxes.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]));
    let g = '<g transform="translate('+l.x+','+l.y+') scale('+K.toFixed(3)+')">'
          + '<circle class="lmdot" r="'+(big?3.4:2.2)+'"></circle>';
    if (!hit){
      boxes.push(box);
      g += '<text class="lmtxt'+(big?" big":"")+'" x="'+(left?-9:9)+'" text-anchor="'+(left?"end":"start")+'">'+l.n+'</text>';
    }
    out.push(g + '</g>');
  }
  $("#gLm").innerHTML = out.join("");
}

/* ---------- runner markers ---------- */
function renderRunners(){
  const s = 1/K;                                   // screen px per viewBox unit
  const items = runners.map(r => {
    const d = distAt(r, t), [x,y] = posAt(d);
    return { r, d, x, y, sx: x*s, sy: y*s, st: statusOf(r, t) };
  });
  /* nudge overlapping markers apart in screen space so bunched runners stay readable */
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
    const x = o.sx*K, y = o.sy*K;
    const cls = "rm " + o.st + (selected === o.r.id ? " sel" : "");
    return '<g class="'+cls+'" data-id="'+o.r.id+'" transform="translate('
      + x.toFixed(1)+','+y.toFixed(1)+') scale('+K.toFixed(3)+')">'
      + '<line stroke="'+o.r.colour+'" stroke-width="1.4" opacity=".5" x1="0" y1="0" x2="'
        + ((o.x-x)/K).toFixed(1)+'" y2="'+((o.y-y)/K).toFixed(1)+'"></line>'
      + '<circle class="halo" r="19"></circle>'
      + '<circle class="ring" r="13" fill="'+o.r.colour+'"></circle>'
      + '<text class="ini">'+o.r.ini+'</text></g>';
  }).join("");
}

function renderPin(){
  if (pin == null){ $("#gPin").innerHTML = ""; return; }
  const [x,y] = posAt(pin);
  $("#gPin").innerHTML = '<g transform="translate('+x.toFixed(1)+','+y.toFixed(1)+') scale('+K.toFixed(3)+')">'
    + '<circle class="pin" r="6"></circle><circle class="pin" r="13" fill="none" opacity=".45"></circle></g>';
}

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
      : paceStr(effGoal(r)/42.195) + "/km &middot; finish " + hhmm(finishMin(r));
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
  const s = hhmm(t);
  $("#clock").textContent = s;
  const running = runners.filter(r => statusOf(r,t) === "run").length;
  const waiting = runners.filter(r => statusOf(r,t) === "wait").length;
  $("#clocksub").textContent = !runners.length ? "Add your runners"
    : running ? running + " on course" + (waiting ? " \u00b7 " + waiting + " to start" : "")
    : waiting ? waiting + " still to start" : "all finished";
  $("#nowBtn").dataset.live = live ? "1" : "0";
}
function renderAll(){ renderRunners(); renderPin(); renderPanel(); renderClock(); }

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
const T_MIN = 5*60, T_MAX = 15*60;
let vel = 0, coasting = null, lastWhole = Math.floor(t), timeTouched = false;
/* where to sit when we are not tracking live: just as the first wave goes */
function defaultTime(){
  const starts = runners.map(effStart).filter(v => isFinite(v));
  return starts.length ? clamp(Math.min.apply(null, starts), T_MIN, T_MAX) : 6*60 + 30;
}

/* only the ticks turn - the rim highlight stays put, like light on real glass */
function spinTicks(){
  const a = t*360/MIN_PER_TURN;
  ticksG.setAttribute("transform","rotate("+a.toFixed(2)+" 100 100)");
}
function setTime(v, fromLive){
  t = clamp(v, T_MIN, T_MAX);
  if (!fromLive) live = false;
  const w = Math.floor(t);
  if (w !== lastWhole){
    lastWhole = w;
    if (navigator.vibrate){ try{ navigator.vibrate(6); }catch(e){} }
  }
  spinTicks(); renderAll();
  if (typeof saveView === "function") saveView();
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
  e.stopPropagation(); timeTouched = true; live = true; setTime(sydneyNowMin(), true);
});
setInterval(() => { if (live && !dragging && isRaceDay()) setTime(sydneyNowMin(), true); }, 1000);

/* ---------- pan & zoom ---------- */
function mapPointAt(cx, cy){
  const p = svg.createSVGPoint(); p.x = cx; p.y = cy;
  const m = svg.getScreenCTM();
  return m ? p.matrixTransform(m.inverse()) : null;
}
function zoomAt(cx, cy, factor){
  const p = mapPointAt(cx, cy); if (!p) return;
  const nw = clamp(view.w/factor, MIN_W, VB[2]), k = nw/view.w;
  view.x = p.x - (p.x - view.x)*k;
  view.y = p.y - (p.y - view.y)*k;
  view.w = nw; view.h = nw*ASPECT;
  applyView();
}
const ptrs = new Map();
let panning = false, moved = 0, pinch = null, suppressClick = false, captured = false;
const onDial = e => e.target.closest(".grab") || e.target.closest(".nowbtn") || e.target.closest(".zoomctl");
function pinchState(){
  const a = [...ptrs.values()]; if (a.length < 2) return null;
  return { d: Math.hypot(a[0].x-a[1].x, a[0].y-a[1].y),
           mx: (a[0].x+a[1].x)/2, my: (a[0].y+a[1].y)/2 };
}
stage.addEventListener("pointerdown", e => {
  if (onDial(e)) return;
  ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if (ptrs.size === 1){
    panning = true; moved = 0; captured = false;
  } else if (ptrs.size === 2){
    panning = false; pinch = pinchState();
  }
});
stage.addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) return;
  const prev = ptrs.get(e.pointerId);
  ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if (ptrs.size === 1 && panning){
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    moved += Math.hypot(dx, dy);
    if (!captured && moved > 6){
      captured = true;
      try{ stage.setPointerCapture(e.pointerId); }catch(_){}
      stage.classList.add("panning");
      $("#hint").classList.add("gone");
    }
    if (!captured) return;
    view.x -= dx*K; view.y -= dy*K;
    applyView();
  } else if (ptrs.size === 2){
    const cur = pinchState();
    if (pinch && cur && pinch.d > 0){
      view.x -= (cur.mx - pinch.mx)*K;
      view.y -= (cur.my - pinch.my)*K;
      zoomAt(cur.mx, cur.my, cur.d/pinch.d);
      moved += 12;
    }
    pinch = cur;
  }
});
function endPan(e){
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (ptrs.size === 0){
    if (panning && moved > 6) suppressClick = true;
    panning = false; captured = false; stage.classList.remove("panning");
  }
}
stage.addEventListener("pointerup", endPan);
stage.addEventListener("pointercancel", endPan);
stage.addEventListener("wheel", e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY*0.0018));
}, {passive:false});
stage.addEventListener("dblclick", e => {
  if (onDial(e)) return;
  zoomAt(e.clientX, e.clientY, 1.9);
});
const stageCentre = () => {
  const r = stage.getBoundingClientRect();
  return [r.left + r.width/2, r.top + r.height/2];
};
$("#zIn").addEventListener("click", () => { const c = stageCentre(); zoomAt(c[0], c[1], 1.6); });
$("#zOut").addEventListener("click", () => { const c = stageCentre(); zoomAt(c[0], c[1], 1/1.6); });
$("#zFit").addEventListener("click", () => {
  view = {x:0, y:0, w:VB[2], h:VB[3]};
  applyView();
});
/* centre the view on a point at a given width - used when you pick a runner */
function focusOn(x, y, w){
  view.w = clamp(w, MIN_W, VB[2]); view.h = view.w*ASPECT;
  view.x = x - view.w/2; view.y = y - view.h/2;
  applyView();
}

/* ---------- selection & course tap ---------- */
stage.addEventListener("click", e => {
  if (suppressClick){ suppressClick = false; return; }
  const rm = e.target.closest(".rm");
  if (rm){ selected = rm.dataset.id; renderAll(); openDetail(selected); return; }
  if (onDial(e)) return;
  const p = mapPointAt(e.clientX, e.clientY);
  if (!p) return;
  const hit = nearestDist(p.x, p.y);
  if (hit.err * (1/K) > 26){ pin = null; selected = null; renderAll(); return; }
  pin = hit.d; renderAll(); openPasses(hit.d);
});
$("#rlist").addEventListener("click", e => {
  const c = e.target.closest(".rcard");
  if (!c) return;
  selected = c.dataset.id;
  const r = runners.find(x => x.id === selected);
  if (r && view.w < VB[2]*0.9){
    const p = posAt(distAt(r, t));
    focusOn(p[0], p[1], view.w);
  }
  renderAll(); openDetail(selected);
});
window.addEventListener("resize", () => { applyView(); renderPanel(); renderClock(); });

const scrim = $("#scrim"), modal = $("#modal");
function openModal(html){ modal.innerHTML = html; scrim.classList.add("open"); }
function closeModal(){ scrim.classList.remove("open"); modal.innerHTML = ""; }
scrim.addEventListener("click", e => { if (e.target === scrim) closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

/* ---------- add / edit ---------- */
function openEdit(id){
  const r = runners.find(x => x.id === id);
  const isNew = !r;
  const cur = r || {name:"", start:6*60+30, goal:4*3600, colour:PALETTE[runners.length % PALETTE.length],
                    aStart:null, aGoal:null};
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
    + '<div class="note">Hours:minutes, e.g. <b>3:45</b></div></div>'
  + '<div class="field" id="f-pacewrap" style="display:none"><label for="f-pace">Average pace</label>'
    + '<input id="f-pace" inputmode="numeric" placeholder="5:20" value="'+paceStr(cur.goal/42.195)+'">'
    + '<div class="note">Minutes per km, e.g. <b>5:20</b></div></div>'
  + (isNew ? "" :
      '<div class="field" style="border-top:1px solid var(--line);padding-top:14px;margin-top:4px">'
    + '<label>Actual, once you know it</label>'
    + '<div class="note" style="margin-bottom:8px">Overrides the prediction. Leave blank to keep using the plan above.</div>'
    + '<div class="two">'
      + '<div class="field" style="margin:0"><label for="f-astart">Real start</label>'
        + '<input id="f-astart" type="time" value="'+(cur.aStart!=null?hhmm(cur.aStart):"")+'"></div>'
      + '<div class="field" style="margin:0"><label for="f-apace">Real pace</label>'
        + '<input id="f-apace" inputmode="numeric" placeholder="5:20" value="'+(cur.aGoal!=null?paceStr(cur.aGoal/42.195):"")+'"></div>'
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
                               : (parsePace($("#f-pace").value) || 0) * 42.195;
    if (start == null){ flag("#f-start", "Needs a start time"); return; }
    if (!goal || goal < 1800 || goal > 12*3600){
      flag(mode==="goal" ? "#f-goal" : "#f-pace",
           mode==="goal" ? "Use hours:minutes, like 3:45" : "Use minutes per km, like 5:20"); return;
    }
    let aStart = null, aGoal = null;
    if (!isNew){
      const as = parseClock($("#f-astart").value);
      if (as != null && as >= 4*60 && as <= 15*60) aStart = as;
      const ap = parsePace($("#f-apace").value);
      if (ap && ap * 42.195 >= 1800 && ap * 42.195 <= 12*3600) aGoal = ap * 42.195;
    }
    if (isNew){
      runners.push({id: "r"+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36),
        name, ini: initials(name), colour, start, goal: Math.round(goal), aStart, aGoal});
    } else {
      Object.assign(r, {name, ini: initials(name), colour, start, goal: Math.round(goal),
        aStart, aGoal: aGoal != null ? Math.round(aGoal) : null});
    }
    save(); closeModal(); renderAll();
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
  const d = distAt(r, t), st = statusOf(r, t), pace = effGoal(r)/42.195;
  const label = {run:"On course", wait:"Not started", done:"Finished"}[st];
  const marks = [5,10,15,20,25,30,35,40].map(k => k*1000).concat([TOTAL]);
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
  const km = d/1000;
  const near = MAP.landmarks.reduce((best,l) => {
    const p = posAt(d), dd = Math.hypot(l.x-p[0], l.y-p[1]);
    return dd < best.dd ? {dd, n:l.n} : best;
  }, {dd:Infinity, n:""});
  const rows = runners.map(r => ({r, at: timeAtDist(r, d)}))
                      .sort((a,b) => a.at - b.at);
  openModal(
    '<h3>'+km.toFixed(1)+' km point</h3>'
  + '<p class="sub">'+(near.dd < 260 ? "Near "+esc(near.n)+" &middot; " : "")
      + 'When each runner reaches this spot.</p>'
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
      runners = list; selected = null; save(); closeModal(); renderAll();
    }catch(e){
      const m = $("#c-msg"); m.textContent = "That code didn’t read properly — copy it again in full."; m.style.color = "#c0392b";
    }
  });
}

/* ---------- per-viewer view state (survives a reload) ---------- */
const VKEY = "sms.view";
let vTimer = null;
function saveView(){
  clearTimeout(vTimer);
  vTimer = setTimeout(() => {
    try{ sessionStorage.setItem(VKEY, JSON.stringify({t, live, view})); }catch(e){}
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

runners = load() || seed();
svg.setAttribute("viewBox", VB.join(" "));
renderStatic();
$("#zOut").disabled = true;

let restored = null;
try{ restored = JSON.parse(sessionStorage.getItem(VKEY) || "null"); }catch(e){}
if (restored && restored.view && isFinite(restored.view.w)){
  view = restored.view; applyView();
}
const nowM = sydneyNowMin(), raceDay = isRaceDay();
$("#nowBtn").disabled = !raceDay;
$("#nowBtn").title = raceDay
  ? "Follow the live race clock"
  : "The live clock starts on race morning, Sun 30 Aug";
if (restored && isFinite(restored.t) && !restored.live){ timeTouched = true; setTime(restored.t); }
else if (raceDay && nowM > T_MIN && nowM < T_MAX){ live = true; setTime(nowM, true); }
else setTime(defaultTime());

setTimeout(() => $("#hint").classList.add("gone"), 9000);
