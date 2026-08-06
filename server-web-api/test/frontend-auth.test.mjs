import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const websiteDirectory = path.resolve(testDirectory, "..", "..");

function runBrowserScript(name, window, document) {
    const source = fs.readFileSync(path.join(websiteDirectory, "js", name), "utf8");
    vm.runInNewContext(source, {
        document,
        encodeURIComponent,
        Headers,
        URL,
        URLSearchParams,
        window
    }, { filename: name });
}

test("concurrent session checks share one request and schedule one login redirect", async () => {
    let requestCount = 0;
    let resolveSession;
    let redirectCount = 0;
    let href = "https://www.seabyss.test/profile.html";
    const sessionResult = new Promise((resolve) => {
        resolveSession = resolve;
    });
    const location = {
        pathname: "/profile.html",
        search: "",
        get href() {
            return href;
        },
        set href(value) {
            redirectCount += 1;
            href = value;
        }
    };
    const window = {
        location,
        SeabyssApi: {
            request: async (requestPath) => {
                assert.equal(requestPath, "/auth/session");
                requestCount += 1;
                return sessionResult;
            }
        }
    };
    const document = {
        addEventListener() {},
        getElementById() {
            return null;
        }
    };

    runBrowserScript("auth.js", window, document);
    const first = window.SeabyssAuth.requireSession();
    const second = window.SeabyssAuth.requireSession();
    resolveSession({ loggedIn: false });

    assert.equal(await first, null);
    assert.equal(await second, null);
    assert.equal(requestCount, 1);
    assert.equal(redirectCount, 1);
    assert.equal(href, "login.html?v=2&returnTo=profile.html");
});

test("profile page does not request /me after an unauthenticated session", async () => {
    let profileRequestCount = 0;
    let domReady;
    const message = { textContent: "", className: "" };
    const document = {
        addEventListener(name, callback) {
            if (name === "DOMContentLoaded") {
                domReady = callback;
            }
        },
        getElementById(id) {
            return id === "profile-message" ? message : null;
        },
        querySelectorAll() {
            return [];
        },
        createElement() {
            return {
                append() {},
                textContent: ""
            };
        }
    };
    const window = {
        SeabyssAuth: {
            requireSession: async () => null
        },
        SeabyssApi: {
            request: async () => {
                profileRequestCount += 1;
                return {};
            }
        }
    };

    runBrowserScript("profile.js", window, document);
    domReady();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(profileRequestCount, 0);
});

test("authenticated controls are hidden by default and hidden always wins in CSS", () => {
    const pageNames = [
        "index.html",
        "download.html",
        "login.html",
        "register.html",
        "profile.html",
        "market.html",
        "support.html",
        "privacy.html"
    ];

    for (const pageName of pageNames) {
        const html = fs.readFileSync(path.join(websiteDirectory, pageName), "utf8");
        const authenticatedControls = html.match(/<[^>]+data-auth-show="connected"[^>]*>/g) || [];
        assert.ok(authenticatedControls.length > 0, `${pageName} must declare authenticated controls`);
        for (const element of authenticatedControls) {
            assert.match(element, /\shidden(?:\s|>)/, `${pageName} authenticated controls must fail closed`);
        }
    }

    const css = fs.readFileSync(path.join(websiteDirectory, "css", "style.css"), "utf8");
    assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s);
});
