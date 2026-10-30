/** The HTML front page of a Bayanihan Server. Self-contained: inline CSS, one image from dasig.org. */
const SMALL = 5;
const shown = (n: number) => (n === 0 ? "None yet" : n < SMALL ? "A few" : String(n));

export function frontPage(o: { ecosystem: boolean; groups: number; projects: number }): string {
  const name = o.ecosystem ? "Dasig Ecosystem" : "Bayanihan Server";
  const blurb = o.ecosystem
    ? "The hosted home for Dasig groups. Groups keep their records here so members can reach them from any phone, and groups that choose to can be found by volunteers nearby."
    : "A Bayanihan Server keeps one group's records: its teams, tasks and signed work. The Dasig app talks to it.";
  const counts = o.ecosystem
    ? `<div class="counts"><div><b>${shown(o.groups)}</b><span>groups you can find</span></div><div><b>${shown(o.projects)}</b><span>open projects</span></div></div>
<p class="fine">Only groups that chose “Anyone can find it” are counted. Everything else is invite-only.</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${name}</title><link rel="icon" href="https://dasig.org/dasig-emblem-hands.png">
<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0F172A;background:#FFF6E9}
main{max-width:560px;margin:0 auto;padding:28px 20px 48px}
.top{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px}.top img{width:36px;height:36px}
.pill{display:inline-flex;align-items:center;gap:8px;margin:28px 0 10px;padding:6px 12px;border-radius:999px;background:#fff;font-size:13.5px;font-weight:600;color:#475569}
.dot{width:9px;height:9px;border-radius:50%;background:#22A55B;box-shadow:0 0 0 4px rgba(34,165,91,.15)}
h1{font-size:34px;line-height:1.1;letter-spacing:-.8px;margin:0 0 12px}p{color:#475569;margin:0 0 16px}
.counts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:22px 0 8px}.counts div{background:#fff;border-radius:22px;padding:16px}
.counts b{display:block;font-size:26px;color:#F47C26}.counts span{font-size:14px;color:#475569}.fine{font-size:13.5px}
.btn{display:flex;align-items:center;justify-content:center;min-height:50px;border-radius:999px;background:#F47C26;color:#fff;font-weight:700;text-decoration:none;margin:22px 0 10px}
.btn:hover{background:#E85C21}
ul{list-style:none;padding:0;margin:26px 0 0;background:#fff;border-radius:22px;overflow:hidden}
li a{display:flex;justify-content:space-between;align-items:center;min-height:60px;padding:10px 18px;color:#0F172A;text-decoration:none;font-weight:600;border-top:1px solid #F3EDE4}
li:first-child a{border-top:0}li a::after{content:"›";color:#F47C26;font-size:22px}li small{display:block;font-weight:400;color:#64748B;font-size:13px}
footer{margin-top:28px;font-size:13px;color:#64748B}footer a{color:#475569}
</style></head><body><main>
<div class="top"><img src="https://dasig.org/dasig-emblem-hands.png" alt="">${name}</div>
<div class="pill"><span class="dot"></span>Running${o.ecosystem ? " · in pilot" : ""}</div>
<h1>${o.ecosystem ? "Where Dasig groups keep their records" : "This server is running"}</h1>
<p>${blurb}</p>
${counts}
<a class="btn" href="https://bayanihan.dasig.org/get">Get the Dasig app</a>
<ul>
<li><a href="https://bayanihan.dasig.org/directory"><span>Find a group<small>Groups that chose to be found</small></span></a></li>
<li><a href="https://bayanihan.dasig.org/trust/privacy"><span>Privacy<small>What's kept, and who can see it</small></span></a></li>
${o.ecosystem ? `<li><a href="https://bayanihan.dasig.org/trust/host-policy"><span>Host policy<small>How this server is run</small></span></a></li>` : ""}
<li><a href="https://bayanihan.dasig.org/docs/api"><span>For developers<small>The API this server speaks</small></span></a></li>
<li><a href="https://bayanihan.dasig.org/docs/self-hosting"><span>Run your own<small>Self-hosting guide</small></span></a></li>
<li><a href="/metadata"><span>/metadata<small>What this server supports, as JSON</small></span></a></li>
</ul>
<footer>BIX v0.1 · Bayanihan Server 0.1.0${o.ecosystem ? " · Questions: <a href=\"mailto:hello@dasig.org\">hello@dasig.org</a>" : ""}</footer>
</main></body></html>`;
}
