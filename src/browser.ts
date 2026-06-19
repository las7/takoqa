/**
 * Browser session wrapper. Owns the Playwright lifecycle and continuously
 * captures the runtime signals the oracles need: console errors, uncaught
 * exceptions, and HTTP responses. Captured events accumulate in a buffer that
 * the engine drains after each step.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { settle } from "./settle.js";
import type { Auth } from "./types.js";

export interface ConsoleEvent {
  type: string;
  text: string;
  url: string;
}

export interface PageErrorEvent {
  message: string;
  stack?: string;
  url: string;
}

export interface ResponseEvent {
  status: number;
  url: string;
  method: string;
  /** Playwright's request initiator class ("document" | "image" | "fetch" | …),
   *  set by the request, not the response — so it survives a 404. Lets oracles
   *  tell a failed navigation from a failed image/asset sub-resource. */
  resourceType?: string;
  /** Lowercased response headers, captured only when body capture is on. */
  headers?: Record<string, string>;
  /** Response body (capped), captured only for same-origin html/json when on. */
  body?: string;
}

/** A Set-Cookie observed on a response, parsed for its security attributes. */
export interface SetCookieEvent {
  name: string;
  url: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
}

export interface CapturedEvents {
  console: ConsoleEvent[];
  pageErrors: PageErrorEvent[];
  responses: ResponseEvent[];
  cookies: SetCookieEvent[];
}

/** Largest response body we keep, so a huge HTML/JSON page can't blow up memory. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Parse a single raw Set-Cookie header value into its security-relevant
 * attributes. Pure. The cookie name is the substring before the first '='; the
 * attribute scan is case-insensitive. SameSite returns its declared value
 * (e.g. "Lax") or null when absent.
 */
export function parseSetCookie(raw: string, url: string): SetCookieEvent {
  const eq = raw.indexOf("=");
  const name = (eq === -1 ? raw : raw.slice(0, eq)).trim();
  const attrs = raw
    .split(";")
    .slice(1)
    .map((a) => a.trim());
  const httpOnly = attrs.some((a) => /^httponly$/i.test(a));
  const secure = attrs.some((a) => /^secure$/i.test(a));
  const sameSiteAttr = attrs.find((a) => /^samesite=/i.test(a));
  const sameSite = sameSiteAttr
    ? (sameSiteAttr.split("=")[1] ?? "").trim() || null
    : null;
  return { name, url, httpOnly, secure, sameSite };
}

export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;

  private events: CapturedEvents = {
    console: [],
    pageErrors: [],
    responses: [],
    cookies: [],
  };
  private tracing = false;
  /**
   * Body/cookie reads are async (Playwright's `Response.text()` and
   * `headersArray()` return promises), but the `response` listener is sync. We
   * collect the in-flight reads here and await them in drainEvents so the body
   * + parsed cookies are present before the oracles run on a step's events.
   * ONLY populated when captureBodies is on — a no-security run pushes nothing
   * here, so drainEvents awaits an empty list and stays effectively sync.
   */
  private pendingReads: Promise<void>[] = [];

  /**
   * @param recordDir If set, a Playwright video is recorded and a trace is
   *   captured; both are saved here when the session closes. If undefined,
   *   recording is off (used for fast, artifact-free runs).
   * @param captureBodies If true, same-origin html/json response bodies + parsed
   *   Set-Cookie attributes are captured for the security oracles. Off by
   *   default — a profile without a `security` block pays nothing.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly headless: boolean,
    private readonly recordDir?: string,
    private readonly captureBodies = false,
  ) {}

  async start(auth: Auth): Promise<void> {
    // --no-sandbox is required when Chromium runs as root (containers/CI);
    // --disable-dev-shm-usage avoids crashes on small /dev/shm in Docker.
    this.browser = await chromium.launch({
      headless: this.headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      viewport: { width: 1280, height: 900 },
    };
    if (auth.strategy === "storageState")
      contextOptions.storageState = auth.path;
    if (auth.strategy === "loginForm")
      throw new Error(
        "loginForm auth is not implemented — provide a saved Playwright session via " +
          'auth: { strategy: "storageState", path: ... } instead.',
      );
    if (this.recordDir) {
      contextOptions.recordVideo = { dir: join(this.recordDir, "video-raw") };
    }
    this.context = await this.browser.newContext(contextOptions);

    if (this.recordDir) {
      await this.context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: false,
      });
      this.tracing = true;
    }

    this.page = await this.context.newPage();
    this.wireListeners();
  }

  /** Stops tracing and writes the trace zip. Safe to call when not tracing. */
  async stopTracing(path: string): Promise<void> {
    if (this.tracing) {
      await this.context.tracing.stop({ path });
      this.tracing = false;
    }
  }

  private wireListeners(): void {
    this.page.on("console", (msg) => {
      if (msg.type() === "error") {
        this.events.console.push({
          type: msg.type(),
          text: msg.text(),
          url: this.page.url(),
        });
      }
    });

    this.page.on("pageerror", (err) => {
      this.events.pageErrors.push({
        message: err.message,
        stack: err.stack,
        url: this.page.url(),
      });
    });

    this.page.on("response", (res) => {
      // Snapshot the current batch + read-list AT THE TOP, so a response that
      // fires DURING a drainEvents await (after this.events/this.pendingReads
      // have been swapped) is attributed wholly to the FRESH batch — its
      // ResponseEvent, body, and cookies all land together in the same batch and
      // none is lost or written into the wrong (already-drained) one.
      const batch = this.events;
      const reads = this.pendingReads;
      const event: ResponseEvent = {
        status: res.status(),
        url: res.url(),
        method: res.request().method(),
        resourceType: res.request().resourceType(),
      };
      // The {status,url,method} push is UNCONDITIONAL — functional oracles and
      // the authz reachedRoutes status need it on every run. Everything below
      // (headers, Set-Cookie parse, body) is gated on captureBodies so a
      // no-security run pushes NO promises to pendingReads and drainEvents stays
      // effectively sync ("pays nothing").
      if (this.captureBodies) {
        // Headers are sync (a lowercased object). Wrapped in try/catch — a
        // capture failure must never throw out of the listener and abort a run.
        try {
          event.headers = res.headers();
        } catch {
          /* header read is best-effort */
        }
        // Set-Cookie collapses lossily in the headers object (multiple cookies
        // join under one key), so parse from the per-name headers array instead.
        // headersArray() is async, so collect its promise and await in drainEvents.
        reads.push(
          res
            .headersArray()
            .then((arr) => {
              for (const h of arr) {
                if (h.name.toLowerCase() === "set-cookie") {
                  batch.cookies.push(parseSetCookie(h.value, res.url()));
                }
              }
            })
            .catch(() => {
              /* cookie capture is best-effort */
            }),
        );

        // Bodies are only needed by the security oracles and only for same-origin
        // HTML/JSON. text() is async — collect the read.
        if (this.isSameOrigin(res.url())) {
          const ct = (event.headers?.["content-type"] ?? "").toLowerCase();
          if (ct.includes("text/html") || ct.includes("application/json")) {
            reads.push(
              res
                .text()
                .then((body) => {
                  event.body = body.slice(0, MAX_BODY_BYTES);
                })
                .catch(() => {
                  /* body capture is best-effort */
                }),
            );
          }
        }
      }

      batch.responses.push(event);
    });
  }

  private isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  /**
   * Returns events captured since the last drain and clears the buffer. Async
   * because body/cookie reads (Response.text/headersArray) resolve out-of-band;
   * we await the in-flight reads so they're present when the oracles inspect the
   * step's events. When body capture is off, there are NO pending reads, so this
   * awaits an empty list and resolves immediately.
   */
  async drainEvents(): Promise<CapturedEvents> {
    // Snapshot the current pair, then SYNCHRONOUSLY swap in fresh ones BEFORE
    // awaiting. A response that fires during the await captured the fresh pair
    // at the top of its handler (see wireListeners), so it is fully attributed
    // to the next batch — nothing is lost or misattributed to this drained one.
    const drained = this.events;
    const reads = this.pendingReads;
    this.events = { console: [], pageErrors: [], responses: [], cookies: [] };
    this.pendingReads = [];
    try {
      await Promise.all(reads);
    } catch {
      /* individual reads already swallow their own errors */
    }
    return drained;
  }

  async goto(path: string): Promise<void> {
    const url = new URL(path, this.baseUrl).toString();
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    // Let the landed page hydrate/settle before the first observe so we don't
    // stamp refs on nodes that are about to be replaced.
    await settle(this.page);
  }

  url(): string {
    // Safe before start()/goto: if a launch failure lands in the engine's catch
    // block, reading url() there must not throw a second error over the first.
    return this.page?.url() ?? "";
  }

  /**
   * Closes the session. If a videoPath is given and recording was on, the
   * captured video is finalized and saved there (video is only written on
   * context close, so we grab the handle first).
   */
  async close(videoPath?: string): Promise<void> {
    const video = this.recordDir ? this.page?.video() : null;
    await this.context?.close();
    if (video && videoPath) {
      try {
        await video.saveAs(videoPath);
        // Drop Playwright's raw randomly-named copy now that we have a clean one.
        if (this.recordDir)
          rmSync(join(this.recordDir, "video-raw"), {
            recursive: true,
            force: true,
          });
      } catch {
        /* video is best-effort; never fail a run over a missing recording */
      }
    }
    await this.browser?.close();
  }
}
