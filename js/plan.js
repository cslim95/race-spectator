/* ---------- my plan ----------
   Spots on the course where the spectator means to be, and when. A spot is
   stored like a runner position - metres along the course - so who passes and
   when is always worked out live from the runners' current goals and actuals.
   Loaded before app.js; everything here runs only once app.js is up. */

const PKEY = "rs.plan.v1";
const WALK_M_PER_MIN = 5000/60;                 /* 5 km/h */
const SPARE_MIN = 5;                            /* less slack than this between spots counts as tight */
let plan = [], selectedSpot = null, tab = "runners";

function loadPlan(){
  try{
    const d = JSON.parse(localStorage.getItem(PKEY) || "null");
    if (d && Array.isArray(d.spots)) return d.spots.map(normaliseSpot).filter(Boolean);
  }catch(e){}
  return [];
}
function savePlan(){
  try{ localStorage.setItem(PKEY, JSON.stringify({spots: plan})); }catch(e){}
}
/* stored spots are untrusted input - rebuild them field by field */
function normaliseSpot(s){
  const d = Number(s && s.d), time = Number(s && s.time);
  if (!isFinite(d) || d < 0 || d > 400000 || !isFinite(time) || time < 0 || time >= 1440) return null;
  return { id: String(s.id || ("p" + Math.round(d))).slice(0, 24), d, time,
           name: String(s.name || "").slice(0, 60) || (d/1000).toFixed(1) + " km",
           note: String(s.note || "").slice(0, 120) };
}
const sortedPlan = () => plan.slice().sort((a,b) => a.time - b.time || a.d - b.d);

/* every runner's pass time at a spot, earliest first */
const passesAt = d => runners.map(r => ({r, at: timeAtDist(r, d)})).sort((a,b) => a.at - b.at);
function listNames(rows){
  const n = rows.map(o => o.r.name.split(/\s+/)[0]);
  return n.length < 3 ? n.join(" and ") : n.slice(0, -1).join(", ") + " and " + n[n.length-1];
}

/* nearest street name, read from the map's own vector tiles - nothing is sent anywhere */
function nearestStreet(d){
  const ll = posAt(d);
  const kx = 111320*Math.cos(ll[1]*Math.PI/180), ky = 110540;
  let feats = [];
  try{ feats = map.querySourceFeatures("openmaptiles", {sourceLayer:"transportation_name"}); }catch(e){}
  let best = null, bd = 60*60;                  /* within 60 m */
  const NOT_STREETS = ["ferry", "rail", "transit", "aerialway"];
  for (const f of feats){
    const name = f.properties && f.properties.name;
    if (!name || NOT_STREETS.includes(f.properties.class)) continue;
    const g = f.geometry;
    const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const line of lines){
      for (let i = 0; i < line.length - 1; i++){
        const ax = (line[i][0]-ll[0])*kx, ay = (line[i][1]-ll[1])*ky;
        const bx = (line[i+1][0]-ll[0])*kx, by = (line[i+1][1]-ll[1])*ky;
        const dx = bx-ax, dy = by-ay, n2 = dx*dx + dy*dy;
        const u = n2 ? clamp(-(ax*dx + ay*dy)/n2, 0, 1) : 0;
        const ex = ax + u*dx, ey = ay + u*dy, dd = ex*ex + ey*ey;
        if (dd < bd){ bd = dd; best = name; }
      }
    }
  }
  return best;
}

/* ---------- add / edit a spot ---------- */
function passRows(d, arrive){
  const rows = passesAt(d);
  if (!rows.length) return '<div class="empty" style="padding:10px">Add runners to see who passes here.</div>';
  return '<div class="splits">' + rows.map(o => {
    const miss = arrive != null && o.at < arrive;
    return '<div class="split'+(miss?" past":"")+'">'
      + '<span class="chip" style="width:24px;height:24px;font-size:9.5px;background:'+o.r.colour+'">'+o.r.ini+'</span>'
      + '<span>'+esc(o.r.name)+(miss?' <span class="lbl warn">before you arrive</span>':'')+'</span>'
      + '<b>'+hhmm(o.at)+'</b></div>';
  }).join("") + '</div>';
}
function openSpot(id, d){
  const s = plan.find(x => x.id === id);
  const isNew = !s;
  const cur = s || { d, time: Math.round(t), name: nearestStreet(d) || (d/1000).toFixed(1) + " km", note: "" };
  openModal(
    '<h3>'+(isNew ? "Save this spot" : "Edit spot")+'</h3>'
  + '<p class="sub">'+(cur.d/1000).toFixed(2)+' km along the course.</p>'
  + '<div class="field"><label for="s-name">Name</label><input id="s-name" value="'+esc(cur.name)+'" autocomplete="off"></div>'
  + '<div class="two">'
    + '<div class="field"><label for="s-time">Be here by</label><input id="s-time" type="time" value="'+hhmm(cur.time)+'"></div>'
    + '<div class="field"><label for="s-note">Note</label><input id="s-note" value="'+esc(cur.note)+'" placeholder="e.g. north side" autocomplete="off"></div>'
  + '</div>'
  + '<div class="field"><label>Who passes, and when</label><div id="s-pass">'+passRows(cur.d, cur.time)+'</div></div>'
  + '<div class="actions"><button class="tbtn" id="s-cancel" style="flex:0 0 auto">Cancel</button>'
    + '<button class="tbtn primary" id="s-save">'+(isNew ? "Save spot" : "Save")+'</button></div>'
  + (isNew ? "" : '<button class="danger" id="s-del">Remove this spot</button>')
  );
  $("#s-time").addEventListener("input", () => {
    const v = parseClock($("#s-time").value);
    $("#s-pass").innerHTML = passRows(cur.d, v);
  });
  $("#s-cancel").addEventListener("click", closeModal);
  if (!isNew) $("#s-del").addEventListener("click", () => {
    plan = plan.filter(x => x.id !== id);
    if (selectedSpot === id) selectedSpot = null;
    savePlan(); closeModal(); setTime(t, live);
  });
  $("#s-save").addEventListener("click", () => {
    const time = parseClock($("#s-time").value);
    if (time == null){ flag("#s-time", "Needs a time"); return; }
    const next = normaliseSpot({ id: isNew ? "p" + Date.now().toString(36) : id, d: cur.d, time,
                                 name: $("#s-name").value.trim(), note: $("#s-note").value.trim() });
    if (isNew) plan.push(next); else Object.assign(s, next);
    selectedSpot = next.id; pin = null;
    savePlan(); closeModal(); showTab("plan"); setTime(t, live);
  });
}

/* ---------- the plan timeline ---------- */
function spotCard(s, i){
  const rows = passesAt(s.d), missed = rows.filter(o => o.at < s.time);
  const km = (s.d/1000).toFixed(1) + " km";
  const meta = [s.name === km ? "" : km, esc(s.note)].filter(Boolean).join(" &middot; ");
  return '<div class="scard'+(selectedSpot === s.id ? " sel" : "")+'" data-id="'+s.id+'">'
    + '<div class="snum">'+(i+1)+'</div>'
    + '<div><div class="rname">'+esc(s.name)+'</div>'
      + (meta ? '<div class="rmeta">'+meta+'</div>' : '')+'</div>'
    + '<div class="rdist">'+hhmm(s.time)+'<small>be here</small></div>'
    + (rows.length ? '<div class="spass">' + rows.map(o => {
        const miss = o.at < s.time;
        return '<span class="pp'+(miss ? " miss" : "")+'" title="'+esc(o.r.name)+'">'
          + '<i style="background:'+o.r.colour+'">'+o.r.ini+'</i>'+hhmm(o.at)+'</span>';
      }).join("") + '</div>' : '')
    + (missed.length ? '<div class="swarn">You’ll miss '+esc(listNames(missed))+' here</div>' : '')
    + '<button class="sedit" data-edit="'+s.id+'">Edit</button>'
    + '</div>';
}
/* can you get from one spot to the next? You stay until your runners have passed,
   then walk the straight line at 5 km/h - real streets will take longer */
function travelRow(a, b){
  const later = passesAt(a.d).filter(o => o.at >= a.time).map(o => o.at);
  const leave = Math.max(a.time, ...later);
  const walk = haversine(posAt(a.d), posAt(b.d)) / WALK_M_PER_MIN;
  const spare = b.time - leave - walk;
  const st = spare >= SPARE_MIN ? "ok" : spare >= 0 ? "tight" : "short";
  const verdict = st === "ok" ? Math.floor(spare) + " min spare"
                : st === "tight" ? "Tight" : "Short by " + Math.ceil(-spare) + " min";
  return '<div class="travel '+st+'"><span>Leave '+hhmm(leave)+' &middot; ~'+Math.ceil(walk)+' min walk ('
    + (walk*WALK_M_PER_MIN/1000).toFixed(1)+' km)</span><b>'+verdict+'</b></div>';
}
function renderPlan(){
  const list = $("#plist"), spots = sortedPlan();
  $("#planCount").textContent = spots.length || "";
  if (!spots.length){
    list.innerHTML = '<div class="empty">No spots yet.<br>Tap the course where you want to watch, then <b>Save this spot</b>.</div>';
    return;
  }
  const out = [];
  spots.forEach((s, i) => { if (i) out.push(travelRow(spots[i-1], s)); out.push(spotCard(s, i)); });
  if (spots.length > 1) out.push('<div class="plan-foot">Walking times are straight-line at 5 km/h &mdash; real streets take longer.</div>');
  list.innerHTML = out.join("");
}

/* numbered pins with the arrival time, in time order */
function renderSpots(){
  if (!course){ $("#gSpots").innerHTML = ""; return; }
  $("#gSpots").innerHTML = sortedPlan().map((s, i) => {
    const p = map.project(posAt(s.d));
    if (!inView(p, 40)) return "";
    return '<g class="spot'+(selectedSpot === s.id ? " sel" : "")+'" data-id="'+s.id+'" transform="translate('+p.x.toFixed(1)+','+p.y.toFixed(1)+')">'
      + '<rect class="stag" x="6" y="-9" width="50" height="18" rx="9"></rect>'
      + '<circle class="sdot" r="11"></circle>'
      + '<text class="snumt">'+(i+1)+'</text>'
      + '<text class="stimet" x="33">'+hhmm(s.time)+'</text></g>';
  }).join("");
}

/* pick a spot: turn the dial to it and bring it into view */
function focusSpot(id){
  const s = plan.find(x => x.id === id); if (!s) return;
  selectedSpot = id;
  if (course){
    const ll = posAt(s.d), p = map.project(ll);
    const w = svgOverlay.clientWidth, h = svgOverlay.clientHeight;
    if (p.x < w*.15 || p.x > w*.85 || p.y < h*.15 || p.y > h*.85) map.easeTo({center: ll, duration: 500});
  }
  timeTouched = true; setTime(s.time);
}

/* ---------- panel tabs ---------- */
function showTab(name){
  tab = name;
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $("#rlist").hidden = name !== "runners";
  $("#plist").hidden = name !== "plan";
  $("#clearBtn").textContent = name === "plan" ? "Clear plan" : "Reset";
}
