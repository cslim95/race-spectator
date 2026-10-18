/* ---------- guided tour ----------
   A spotlight walk through the main features: everything but the current
   control is dimmed, with a short card beside it. Runs once per device on
   first visit, and again from the ? button. Loaded after app.js, whose state it drives. */

const TOUR_KEY = "rs.tour.v1";
let tourIdx = -1, tourSpot = null;            /* tourSpot: the course point the tap/save steps use */

const val = x => typeof x === "function" ? x() : x;

const TOUR = [
  { target: () => course ? $("#courseBtn") : $("#emptyCourse .drop"),
    wait:   () => !course,                     /* nothing else works until there is a course */
    title:  () => course ? "Your race course" : "Load your race",
    body:   () => course
      ? "Tap Course any time to change the race details or load a different GPX."
      : "Choose your race’s GPX file from Strava, Garmin or the race website. No file handy? Try the sample race." },
  { target: () => $("#addBtn"),
    title: "Add your runners",
    body: "Give each runner a start time and a goal finish or pace. Their place on the course is predicted from that." },
  { target: () => $("#dialwrap"), round: true,
    title: "Turn the dial",
    body: "Drag the ring to move through race morning. Every runner moves along the course with it." },
  { target: () => pointRect(tourSpot), round: true,
    enter: () => { tourSpot = tourPoint(); pin = tourSpot; renderAll(); },
    title: "Tap the course",
    body: "Tap anywhere on the route to see exactly when each runner will pass that point." },
  { target: () => $("#p-save"), overModal: true,
    enter: () => openPasses(tourSpot != null ? tourSpot : TOTAL/2),
    leave: () => closeModal(),
    title: "Save this spot",
    body: "Set the dial to when you’ll be there, then save the spot. It goes into your plan." },
  { target: () => $('.tabs button[data-tab="plan"]'),
    enter: () => showTab("plan"),
    title: "Your plan",
    body: "Your spots in time order: who passes each one, who you’d miss, and whether you can walk to the next one in time." },
  { target: () => $("#rlist .rcard") || $("#rlist"),
    enter: () => showTab("runners"),
    title: "Use real times",
    body: "Once a runner has started, tap them and choose Edit & set actuals. Enter their real start or pace and every prediction updates." },
  { target: () => $("#helpBtn"),
    title: "You’re all set",
    body: "Replay this tour any time from here." },
];

/* a point on the course that is on screen and clear of the dial */
function tourPoint(){
  const d = dial.getBoundingClientRect(), s = $("#map").getBoundingClientRect();
  const cx = d.left + d.width/2 - s.left, cy = d.top + d.height/2 - s.top, rr = d.width/2 + 30;
  for (const f of [.3, .2, .4, .7, .6, .15, .8, .5, .1, .9]){
    const p = map.project(posAt(TOTAL*f));
    if (p.x > 40 && p.y > 40 && p.x < s.width - 60 && p.y < s.height - 40 && Math.hypot(p.x - cx, p.y - cy) > rr) return TOTAL*f;
  }
  return TOTAL*.3;
}
function pointRect(dist){
  const s = $("#map").getBoundingClientRect(), p = map.project(posAt(dist));
  return {left: s.left + p.x - 22, top: s.top + p.y - 22, width: 44, height: 44};
}

const tourEl = $("#tour"), hole = tourEl.querySelector(".tour-hole"), card = tourEl.querySelector(".tour-card");

function showStep(i){
  const prev = TOUR[tourIdx];
  if (prev && prev.leave && i !== tourIdx) prev.leave();
  tourIdx = i;
  const s = TOUR[i];
  if (s.enter) s.enter();
  const waiting = !!(s.wait && s.wait());
  tourEl.hidden = false;
  tourEl.classList.toggle("waiting", waiting);       /* clicks pass through to the app while we wait */
  tourEl.classList.toggle("over-modal", !!s.overModal);
  card.querySelector(".tour-step").textContent = (i+1) + " of " + TOUR.length;
  card.querySelector("h4").textContent = val(s.title);
  card.querySelector("p").textContent = val(s.body);
  card.querySelector("[data-back]").hidden = i === 0;
  const next = card.querySelector("[data-next]");
  next.hidden = waiting;
  next.textContent = i === TOUR.length - 1 ? "Done" : "Next";
  positionTour();                                  /* now, and again once the card has laid out */
  requestAnimationFrame(positionTour);
  if (!waiting) next.focus({preventScroll:true});
}
function positionTour(){
  if (tourIdx < 0) return;
  const s = TOUR[tourIdx], t = s.target();
  if (!t) return;
  const r = t.getBoundingClientRect ? t.getBoundingClientRect() : t, pad = 6;
  Object.assign(hole.style, {
    left: (r.left - pad) + "px", top: (r.top - pad) + "px",
    width: (r.width + pad*2) + "px", height: (r.height + pad*2) + "px",
    borderRadius: s.round ? "50%" : "14px",
  });
  /* the card goes below the target if it fits, else above, else along the bottom edge */
  const vw = innerWidth, vh = innerHeight, w = card.offsetWidth, h = card.offsetHeight, gap = 14;
  let top = r.top + r.height + pad + gap;
  if (top + h > vh - 12) top = r.top - pad - gap - h;
  if (top < 12) top = vh - h - 12;
  card.style.top = top + "px";
  card.style.left = clamp(r.left + r.width/2 - w/2, 12, vw - w - 12) + "px";
}

function startTour(){ closeModal(); showStep(0); }
function endTour(){
  const s = TOUR[tourIdx];
  if (s && s.leave) s.leave();
  tourIdx = -1; tourEl.hidden = true;
  pin = null; renderAll();
  try{ localStorage.setItem(TOUR_KEY, "done"); }catch(e){}
}
function tourSeen(){ try{ return !!localStorage.getItem(TOUR_KEY); }catch(e){ return true; } }
/* called once a course is loaded, so a tour waiting on step 1 can carry on */
function tourCourseLoaded(){
  if (tourIdx === 0) showStep(0);
}

card.querySelector("[data-next]").addEventListener("click", () =>
  tourIdx === TOUR.length - 1 ? endTour() : showStep(tourIdx + 1));
card.querySelector("[data-back]").addEventListener("click", () => showStep(Math.max(0, tourIdx - 1)));
card.querySelector(".tour-skip").addEventListener("click", endTour);
document.addEventListener("keydown", e => {
  if (tourIdx < 0) return;
  if (e.key === "Escape") endTour();
  else if (e.key === "ArrowRight" && !card.querySelector("[data-next]").hidden) card.querySelector("[data-next]").click();
  else if (e.key === "ArrowLeft" && tourIdx > 0) showStep(tourIdx - 1);
});
addEventListener("resize", positionTour);
map.on("move", positionTour);                    /* the tap step follows its point on the course */
$("#helpBtn").addEventListener("click", startTour);
if (!tourSeen()) setTimeout(startTour, 700);
