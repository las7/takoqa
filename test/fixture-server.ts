/**
 * A throwaway web app with PLANTED bugs, used to test the QA agent itself.
 *
 * The agent's job is to catch bugs; the only way to trust it is to point it at
 * an app whose bugs we already know and confirm it finds them (and stays quiet
 * on the clean page). This server is that known-buggy app.
 *
 *   /settings  -> "Save" button whose handler logs console.error AND throws an
 *                 uncaught exception. Expected findings: console_error + page_error.
 *   /api-fail  -> page that fires a fetch returning HTTP 500. Expected: http_error.
 *   /clean     -> a button that works correctly. Expected: no findings.
 *   /noop      -> an inert button; clicking changes nothing. Expected: no_progress.
 *   /gated     -> 302-redirects to /landing before load. Expected: route_gated (skip).
 *   /late      -> renders a button ~300ms after load. Used to test settle().
 *   /toggle    -> two inert buttons; A<->B alternation never progresses. no_progress.
 *   /slowgate  -> loads OK, then client-redirects ~800ms later. Delayed route_gated.
 *   /canvas    -> a <canvas>; a drag draws a box (no DOM refs). Tests drag gesture.
 *   /coord     -> an untagged <div> with click/dblclick. Tests click_at/double_click.
 *   /relog     -> button logs an identical console.error each click (title bumps to
 *                 dodge the loop guard). Tests within-run finding dedupe (occurrences).
 *   /dense     -> 130+ buttons + disabled/off-screen/unlabeled ones. Tests the
 *                 observe() relevance filter (viewport-clip, drop junk, cap).
 *   /busy      -> mutates the DOM forever; never quiesces. Tests settle() signal.
 *   /loaderror -> throws an uncaught exception on load. Tests crawl mode.
 *   /agent-loaderror -> throws on load + has a button; an AGENT mission starts
 *                 here. Tests that agent mode runs oracles on the start-page load.
 *   /gone      -> returns HTTP 404 for the page document. Expected: dead_link
 *                 (below the 500 http_error threshold, so a distinct detector).
 *   /broken-image -> a 200 page whose <img> src 404s. Expected: broken_image
 *                 (an image sub-resource 404 that dead_link/http_error both miss).
 *   /broken-asset -> a 200 page whose <script> AND stylesheet srcs 404. Expected:
 *                 broken_asset (script/stylesheet 404 — higher impact than image).
 *   /a11y-img  -> a 200 page with a rendered <img> that has no alt attribute.
 *                 Expected: accessibility (WCAG 1.1.1, from the observe DOM scan).
 *   /a11y-button -> a 200 page with an icon-only <button> (no accessible name).
 *                 Expected: accessibility (WCAG 4.1.2, the control-name rule).
 *   /a11y-input -> a 200 page with a bare unlabeled <input>. Expected:
 *                 accessibility (WCAG 4.1.2/3.3.2, the form-field rule).
 *   /a11y-orphan -> a <label for> pointing to a missing id. Expected:
 *                 accessibility (WCAG 1.3.1, the orphan-label rule).
 *   /a11y-hidden -> a labeled control + unlabeled controls/field/img that are all
 *                 non-perceivable (visibility:hidden / aria-hidden). CLEAN agent
 *                 mission: the a11y hidden() gate must exclude them all (0 findings).
 *   /dup-id    -> two elements share an id. Expected: duplicate_id (DOM-correctness
 *                 scan, from observe).
 *   /occluded  -> a visible button whose centre is permanently covered by a
 *                 foreign overlay div. Expected: occluded_control (the agent
 *                 clicks the surfaced-but-unclickable button).
 *   /body-error -> 200 OK whose VISIBLE text contains a crash marker ("Application
 *                 error") without any 5xx — a soft error page. Expected:
 *                 body_error_signature (and NOT http_error, since it is a 200).
 *
 *   --- authz matrix routes (crawled once per variant; see the matrix pass) ---
 *   /authn-gap   -> 200 to everyone; expectedAccess allows [viewer, admin]. The
 *                  UNAUTHENTICATED (anon) variant reaches it -> missing_authn.
 *   /authz-gap   -> 200 to everyone; expectedAccess allows [anon, admin]. The
 *                  authenticated-but-under-privileged (viewer) variant reaches
 *                  it -> broken_authz (IDOR).
 *   /authz-clean -> 200 to everyone; expectedAccess allows every variant — the
 *                  authz-clean baseline. Expected: NO authz findings.
 *
 *   --- Security routes (paired clean/bad, for the scored self-eval) ---
 *   /sec-clean   -> all four security headers + a hardened session cookie.
 *                   The security-clean baseline. Expected: NO security findings.
 *   /sec-headers -> omits the security headers (sets a non-session cookie).
 *                   Expected: insecure_headers.
 *   /sec-cookie  -> Set-Cookie session=abc123 with no HttpOnly/Secure/SameSite.
 *                   Expected: insecure_cookie (when sessionCookieNames:["session"]).
 *   /sec-leak    -> application/json body embedding a JWT. Expected:
 *                   sensitive_data_exposure.
 *   /sec-verbose -> 500 with a Python traceback body. Expected: verbose_error
 *                   (and http_error too — fine).
 *   /sec-reflect -> reflects its ?q= param VERBATIM (un-escaped) into the HTML
 *                   body; carries the security headers so ONLY the reflection
 *                   fires. Driven by a scripted agent that types a metacharacter
 *                   marker then navigates with it. Expected: injection_reflection.
 */

import { createServer, type Server } from "node:http";

export interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/api/boom") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(`{"error":"planted server error"}`);
      return;
    }

    // A page navigation that returns 404 — a broken route / dead link. Below the
    // 500 http_error threshold, so dead_link is the detector that must catch it.
    if (path.startsWith("/gone")) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html(`<h1>Not Found</h1><p>No such page.</p>`));
      return;
    }

    // A 404 on a sub-resource the page referenced: an <img> (image), a <script>
    // (script), or a stylesheet. The embedding PAGE is 200, so neither dead_link
    // (landed doc is 200) nor http_error (404 < 500) fires — only broken_image
    // (image) / broken_asset (script, stylesheet). resourceType is set by the
    // request initiator, so the 404 response's content-type is irrelevant.
    if (path.startsWith("/__broken-")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
      return;
    }

    // A gated route that redirects away before the page loads, like an
    // auth/tier/feature gate. Used to test the route_gated precondition check.
    if (path.startsWith("/gated")) {
      res.writeHead(302, { location: "/landing" });
      res.end();
      return;
    }

    // --- Paired clean/bad SECURITY routes (custom headers/content-type, so
    // they must be served BEFORE the generic 200 text/html writeHead below). ---

    // Security-clean baseline: all four security headers + a hardened session
    // cookie. Must produce NO security findings.
    if (path.startsWith("/sec-clean")) {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'",
        "strict-transport-security": "max-age=31536000",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "set-cookie": "session=abc123; HttpOnly; Secure; SameSite=Strict",
      });
      res.end(html(`<h1>Secure</h1>`));
      return;
    }
    // Missing the security headers (sets a non-session cookie). insecure_headers.
    if (path.startsWith("/sec-headers")) {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "prefs=dark; Path=/",
      });
      res.end(html(`<h1>No Security Headers</h1>`));
      return;
    }
    // A session cookie with no HttpOnly/Secure/SameSite. insecure_cookie (when
    // the eval's security block declares sessionCookieNames:["session"]).
    if (path.startsWith("/sec-cookie")) {
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "session=abc123",
        "content-security-policy": "default-src 'self'",
        "strict-transport-security": "max-age=31536000",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
      });
      res.end(html(`<h1>Weak Cookie</h1>`));
      return;
    }
    // A JSON body that embeds a JWT. sensitive_data_exposure.
    if (path.startsWith("/sec-leak")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123sig"}`);
      return;
    }
    // Reflects ?q= VERBATIM into the HTML body — a reflected-XSS surface. Carries
    // the security headers + no session cookie, so injection_reflection is the
    // ONLY finding (kept single-signal for the mutation/ablation analysis). The
    // agent types a metacharacter marker into #q, then navigates to ?q=<marker>;
    // the marker is reflected un-escaped and the reflection oracle fires.
    if (path.startsWith("/sec-reflect")) {
      const q = new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "";
      res.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'self'",
        "strict-transport-security": "max-age=31536000",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
      });
      res.end(
        html(
          `<h1>Search</h1><input id="q" name="q" placeholder="search">` +
            (q ? `<div id="out">${q}</div>` : ``),
        ),
      );
      return;
    }
    // A 500 leaking a Python traceback. verbose_error (and http_error too).
    if (path.startsWith("/sec-verbose")) {
      res.writeHead(500, { "content-type": "text/html" });
      res.end(
        `Traceback (most recent call last):\n  File "/app/x.py", line 42, in handler\n    raise ValueError("planted leak")\nValueError: planted leak`,
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/html" });

    if (path.startsWith("/settings")) {
      res.end(
        html(`<h1>Settings</h1>
          <button id="save" onclick="(function(){ console.error('planted: save failed'); throw new Error('Save handler exploded'); })()">Save</button>`),
      );
    } else if (path.startsWith("/api-fail")) {
      res.end(
        html(`<h1>Dashboard</h1>
          <button id="load" onclick="fetch('/api/boom')">Load data</button>`),
      );
    } else if (path.startsWith("/clean")) {
      res.end(
        html(`<h1>Clean Page</h1>
          <button id="ok" onclick="document.title='clicked-ok'">OK</button>`),
      );
    } else if (path.startsWith("/noop")) {
      // An inert button: clicking it changes nothing (no nav, no title, no DOM).
      // Used to test the no-progress loop guard.
      res.end(html(`<h1>Dead End</h1><button id="dead">Does Nothing</button>`));
    } else if (path.startsWith("/late")) {
      // Renders a button ~300ms AFTER load, so observing too early misses it.
      // Used to test that settle() waits for post-load DOM changes.
      res.end(
        html(
          `<h1>Late</h1><script>setTimeout(function(){var b=document.createElement('button');b.id='late';b.textContent='Late Button';document.body.appendChild(b);},300)</script>`,
        ),
      );
    } else if (path.startsWith("/toggle")) {
      // Two inert buttons; alternating clicks never make progress. Used to test
      // the loop guard against A<->B cycles (not just identical repeats).
      res.end(
        html(
          `<h1>Toggle</h1><button id="a">A</button><button id="b">B</button>`,
        ),
      );
    } else if (path.startsWith("/slowgate")) {
      // Loads OK, then client-redirects to /landing a beat later — a gate whose
      // check resolves after first paint. Used to test delayed route_gated.
      res.end(
        html(
          `<h1>Slow Gate</h1><button id="x">Wait</button><script>setTimeout(function(){location.replace('/landing')},800)</script>`,
        ),
      );
    } else if (path.startsWith("/canvas")) {
      // A <canvas> whose content has no DOM refs; a mouse drag draws a box and
      // flips #status. Used to test the drag coordinate gesture.
      res.end(
        html(
          `<h1>Canvas</h1><canvas id="c" width="600" height="400" style="position:absolute;left:0;top:60px"></canvas><div id="status">no-draw</div>` +
            `<script>var c=document.getElementById('c'),x=c.getContext('2d'),s=null;` +
            `c.addEventListener('mousedown',function(e){var r=c.getBoundingClientRect();s=[e.clientX-r.left,e.clientY-r.top]});` +
            `window.addEventListener('mouseup',function(e){if(!s)return;var r=c.getBoundingClientRect();x.strokeRect(s[0],s[1],(e.clientX-r.left)-s[0],(e.clientY-r.top)-s[1]);document.getElementById('status').textContent='drew-box';s=null});</script>`,
        ),
      );
    } else if (path.startsWith("/coord")) {
      // A plain <div> with click/dblclick listeners (no role/onclick attr), so
      // observe() never tags it — only a coordinate gesture can hit it.
      res.end(
        html(
          `<h1>Coord</h1><div id="t" style="position:absolute;left:80px;top:120px;width:300px;height:200px;background:#eee"></div><div id="status">none</div>` +
            `<script>var t=document.getElementById('t'),s=document.getElementById('status');` +
            `t.addEventListener('click',function(){s.textContent='clicked'});` +
            `t.addEventListener('dblclick',function(){s.textContent='dblclicked'});</script>`,
        ),
      );
    } else if (path.startsWith("/relog")) {
      // Each click logs the SAME console.error but also bumps document.title, so
      // progressSignature (which includes title) changes every step and the
      // no_progress loop guard never fires — every step re-fires the identical
      // console error, which within-run dedupe must collapse to ONE finding.
      res.end(
        html(
          `<h1>Relog</h1><button id="r" onclick="window.__n=(window.__n||0)+1;document.title='relog-'+window.__n;console.error('planted: recurring error')">Log Again</button>`,
        ),
      );
    } else if (path.startsWith("/dense")) {
      // Many interactive elements + the cases the relevance filter must exclude:
      // a disabled button, an off-screen button, and an unlabeled clickable div.
      // Used to test viewport-clip + drop-disabled/unlabeled + cap.
      res.end(
        html(
          `<h1>Dense</h1>` +
            `<button id="ok">Real Button</button>` +
            `<button id="dis" disabled>Disabled Button</button>` +
            `<div id="nolabel" onclick="void 0" style="width:20px;height:20px"></div>` +
            `<button id="off" style="position:absolute;top:3000px;left:0">Offscreen Button</button>` +
            `<div id="grid"></div>` +
            `<script>var g=document.getElementById('grid');for(var i=0;i<130;i++){var b=document.createElement('button');b.textContent='b'+i;b.style.cssText='width:22px;height:18px;font-size:8px';g.appendChild(b);}</script>`,
        ),
      );
    } else if (path.startsWith("/agent-loaderror")) {
      // Throws on load like /loaderror, but carries a clickable button so an AGENT
      // mission can start here and take a step. The page_error fires during the
      // initial load (in the discarded-by-default load batch), so it is caught ONLY
      // if agent mode runs the invariant oracles on the start-page load batch — the
      // single-signal fixture for that engine behaviour. Not a crawl route.
      res.end(
        html(
          `<h1>Load Error</h1><button id="x">Retry</button>` +
            `<script>throw new Error('boom on agent-start load')</script>`,
        ),
      );
    } else if (path.startsWith("/loaderror")) {
      // Throws an uncaught exception on load (no click needed) — for crawl mode,
      // which only navigates + checks each route.
      res.end(
        html(
          `<h1>Load Error</h1><script>throw new Error('boom on load')</script>`,
        ),
      );
    } else if (path.startsWith("/busy")) {
      // Mutates the DOM continuously, so it never reaches a quiet window —
      // settle() should report it as not-quiesced (drives adaptive fast settle).
      res.end(
        html(
          `<h1>Busy</h1><div id="x"></div><script>setInterval(function(){document.getElementById('x').textContent='t'+Date.now()},50)</script>`,
        ),
      );
    } else if (path.startsWith("/occluded")) {
      // A visible, surfaced button whose centre is permanently covered by a
      // foreign overlay div (fixed, higher stacking, default pointer-events). The
      // button is observable (not hidden/inert) but unclickable — clicking it must
      // produce occluded_control. The overlay has no role/label so observe drops
      // it, keeping the button the single surfaced control (ref 0).
      res.end(
        html(
          `<h1>Occluded</h1>` +
            `<button id="go" style="position:fixed;top:60px;left:60px;width:140px;height:32px">Submit</button>` +
            `<div id="cover" style="position:fixed;top:0;left:0;width:320px;height:200px;background:rgba(0,0,0,0.35);z-index:10"></div>`,
        ),
      );
    } else if (path.startsWith("/body-error")) {
      // A 200 OK whose VISIBLE text carries a crash marker but with NO 5xx — a
      // soft error page. body_error_signature must fire on the page text; there
      // is no http_error because the status is 200.
      res.end(
        html(
          `<h1>Application error</h1><p>Something went wrong rendering this page.</p>`,
        ),
      );
    } else if (path.startsWith("/authn-gap")) {
      // Served 200 to every variant (the planted bug: no real gate). The matrix
      // declares it allows [viewer, admin], so the UNAUTHENTICATED anon variant
      // reaching it is a missing_authn.
      res.end(html(`<h1>Authn Gap</h1><p>account settings</p>`));
    } else if (path.startsWith("/authz-gap")) {
      // Served 200 to every variant. The matrix declares it allows [anon, admin],
      // so the authenticated-but-under-privileged viewer reaching it is a
      // broken_authz (IDOR).
      res.end(html(`<h1>Authz Gap</h1><p>admin console</p>`));
    } else if (path.startsWith("/authz-clean")) {
      // Allowed for every variant in the matrix — the authz-clean baseline. No
      // authz finding for any variant.
      res.end(html(`<h1>Authz Clean</h1><p>public dashboard</p>`));
    } else if (path.startsWith("/broken-image")) {
      // A 200 page referencing an <img> whose src 404s. The image request's
      // resourceType is "image" (set by the initiator, not the 404 response), so
      // broken_image is the SOLE signal — the page document itself is fine.
      res.end(
        html(
          `<h1>Gallery</h1><img src="/__broken-asset.png" alt="thumbnail" width="80" height="80">`,
        ),
      );
    } else if (path.startsWith("/broken-asset")) {
      // A 200 page referencing a <script> AND a stylesheet whose srcs 404. Each
      // request's resourceType is "script"/"stylesheet" (set by the initiator), so
      // broken_asset is the SOLE signal — the page document itself is fine.
      res.end(
        html(
          `<h1>App</h1><link rel="stylesheet" href="/__broken-style.css">` +
            `<script src="/__broken-script.js"></script>`,
        ),
      );
    } else if (path.startsWith("/a11y-img")) {
      // A 200 page with a rendered <img> that has NO alt attribute (WCAG 1.1.1).
      // A data-URI src (loads with no network request, so no broken_image) + an
      // explicit size (so it renders → getClientRects > 0). accessibility is the
      // SOLE signal.
      res.end(
        html(
          `<h1>Gallery</h1><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" width="50" height="50">`,
        ),
      );
    } else if (path.startsWith("/a11y-button")) {
      // A 200 page with an icon-only <button> (an SVG, no text, no aria-label/
      // title) — no accessible name (WCAG 4.1.2). No <img>, so the only signal is
      // accessibility's control-name rule.
      res.end(
        html(
          `<h1>Toolbar</h1><button><svg width="20" height="20"><rect width="20" height="20"></rect></svg></button>`,
        ),
      );
    } else if (path.startsWith("/a11y-input")) {
      // A 200 page with a bare <input> — no <label>, aria-label, title, or
      // placeholder. No <img>/button, so accessibility's form-field rule is the
      // SOLE signal.
      res.end(html(`<h1>Form</h1><input type="text"></input>`));
    } else if (path.startsWith("/a11y-orphan")) {
      // A <label for="nope"> whose target id does not exist — an orphaned label.
      // No control/img/field, so accessibility's orphan-label rule is the SOLE
      // signal.
      res.end(html(`<h1>Orphan</h1><label for="nope">Name</label>`));
    } else if (path.startsWith("/a11y-hidden")) {
      // A labeled, working control (the agent's affordance) PLUS unlabeled
      // controls/field/img that WOULD trip the a11y rules but are all non-
      // perceivable (visibility:hidden / aria-hidden ancestor) — each still has
      // client rects, so only the computed-visibility hidden() gate excludes them.
      // Run as a dedicated CLEAN AGENT mission (its own dedup scope, so its findings
      // can't fingerprint-merge into the dirty a11y crawl routes): it must produce
      // ZERO findings. Reverting the hidden() gate re-flags the hidden elements
      // here (precision regresses) — the load-bearing proof.
      res.end(
        html(
          `<h1>Hidden</h1>` +
            `<button id="ok" onclick="document.title='ok'">OK</button>` +
            `<button style="visibility:hidden"><svg width="20" height="20"></svg></button>` +
            `<input type="text" style="visibility:hidden">` +
            `<div aria-hidden="true"><button><svg width="20" height="20"></svg></button></div>` +
            `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" width="50" height="50" style="visibility:hidden">`,
        ),
      );
    } else if (path.startsWith("/dup-id")) {
      // Two elements share an id — a duplicate_id. No control/img/field, so it is
      // the SOLE signal. Its title is unique, so a crawl route attributes it
      // cleanly (no fingerprint-merge with other fixtures).
      res.end(html(`<h1>Dup</h1><div id="x">A</div><div id="x">B</div>`));
    } else if (path.startsWith("/landing")) {
      res.end(html(`<h1>Landing</h1>`));
    } else {
      res.end(html(`<h1>Home</h1><a href="/settings">Settings</a>`));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
