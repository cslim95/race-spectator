/* ---------- GPX -> course ----------
   Everything here runs in the browser; the file never leaves the device.
   A course is {v, name, date, dist, pts:[[lon,lat],...]} - small enough to store
   locally and, later, to carry inside a share link. */

const STANDARD_DISTANCES = [
  {m:5000, label:"5 km"}, {m:10000, label:"10 km"},
  {m:21097.5, label:"Half marathon"}, {m:42195, label:"Marathon"},
];
const MAX_POINTS = 500;

function haversine(a, b){                     // [lon,lat] pairs -> metres
  const R = 6371008.8, rad = Math.PI/180;
  const dLat = (b[1]-a[1])*rad, dLon = (b[0]-a[0])*rad;
  const s = Math.sin(dLat/2)**2 + Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(s)));
}
function cumulative(pts){
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i-1] + haversine(pts[i-1], pts[i]));
  return cum;
}

/* Douglas-Peucker on a local flat projection - keeps the corners, drops the straight runs */
function simplify(pts, tol){
  const lat0 = pts.reduce((s,p) => s + p[1], 0) / pts.length * Math.PI/180;
  const kx = 111320*Math.cos(lat0), ky = 110540;
  const xy = pts.map(p => [p[0]*kx, p[1]*ky]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length-1] = 1;
  const stack = [[0, pts.length-1]];
  while (stack.length){
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx-ax, dy = by-ay, n2 = dx*dx + dy*dy;
    let worst = -1, wi = -1;
    for (let i = a+1; i < b; i++){
      const t = n2 ? Math.max(0, Math.min(1, ((xy[i][0]-ax)*dx + (xy[i][1]-ay)*dy)/n2)) : 0;
      const ex = xy[i][0] - (ax + t*dx), ey = xy[i][1] - (ay + t*dy);
      const e = ex*ex + ey*ey;
      if (e > worst){ worst = e; wi = i; }
    }
    if (wi > 0 && worst > tol*tol){ keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyTo(pts, max){
  let tol = 3, out = simplify(pts, tol);
  while (out.length > max){ tol *= 1.4; out = simplify(pts, tol); }
  return out;
}

/* nearest standard race distance when the GPX is within 4% of one, else the measured length */
function guessDistance(measured){
  const hit = STANDARD_DISTANCES.find(s => Math.abs(measured - s.m) / s.m < 0.04);
  return hit ? hit.m : Math.round(measured / 10) * 10;
}

function parseGpx(text, fileName){
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("That file isn’t valid GPX.");
  const grab = tag => [...doc.getElementsByTagName(tag)]
    .map(n => [parseFloat(n.getAttribute("lon")), parseFloat(n.getAttribute("lat"))])
    .filter(p => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180);
  let raw = grab("trkpt");
  if (raw.length < 2) raw = grab("rtept");
  if (raw.length < 2) throw new Error("No track or route found in that file.");
  raw = raw.filter((p, i) => i === 0 || p[0] !== raw[i-1][0] || p[1] !== raw[i-1][1]);

  const nameNode = doc.querySelector("metadata > name") || doc.querySelector("trk > name") || doc.querySelector("rte > name");
  const name = ((nameNode && nameNode.textContent) || (fileName || "").replace(/\.gpx$/i, "") || "My race").trim().slice(0, 60);
  const measured = cumulative(raw).pop();
  if (measured < 500) throw new Error("That track is under 500 m - is it the right file?");

  const pts = simplifyTo(raw, MAX_POINTS).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]);
  return { v:1, name, date:"", dist: guessDistance(measured), measured: Math.round(measured), pts };
}

/* a course from storage (or, later, a share link) is untrusted input - rebuild it field by field */
function normaliseCourse(c){
  if (!c || c.v !== 1 || !Array.isArray(c.pts) || c.pts.length < 2 || c.pts.length > 5000) return null;
  const pts = c.pts.map(p => [Number(p[0]), Number(p[1])])
    .filter(p => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180);
  const dist = Number(c.dist);
  if (pts.length < 2 || !isFinite(dist) || dist < 500 || dist > 400000) return null;
  return {
    v:1, pts, dist,
    name: String(c.name || "My race").slice(0, 60),
    date: /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : "",
  };
}

/* distance along the course for each point, stretched so the end lands on the official distance */
function courseCum(course){
  const cum = cumulative(course.pts), k = course.dist / cum[cum.length-1];
  return cum.map(v => v*k);
}
function distLabel(m){
  const s = STANDARD_DISTANCES.find(x => x.m === m);
  return s ? s.label : (m/1000).toFixed(m % 1000 ? 1 : 0) + " km";
}
