// Route-table test: guards against a route being added, removed or
// re-pathed without the README table and downstream proxies (the Apache
// /spr Location) learning about it.
//
// This deliberately does NOT import src/main.js: constructing
// WebSpeechRecorderServer at module scope binds SERVER_PORT and dials
// MongoDB, so an import would make the test suite depend on a free port
// and a running database. Instead the registered routes are extracted
// statically from the source text of setupEndpoints(), which is exactly
// the line pattern every route in this file uses, and compared against
// both the hardcoded expected set and the table in README.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainSource = readFileSync(path.join(root, "src", "main.js"), "utf8");
const readme = readFileSync(path.join(root, "README.md"), "utf8");

// Every route in src/main.js is registered as
//   this.expressApp.<verb>("<path>", ...)
// so extraction is: any expressApp.<verb>( call, except .use (middleware)
// and .listen (starting the server). A registration in any other shape —
// different verb, non-string path — fails loudly here instead of being
// silently skipped.
const NOT_A_ROUTE = new Set(["use", "listen"]);
const REGISTRATION = /this\.expressApp\.(\w+)\s*\(\s*("([^"]*)")?/g;

function registeredRoutes(source) {
    const routes = [];
    for (const match of source.matchAll(REGISTRATION)) {
        const verb = match[1];
        if (NOT_A_ROUTE.has(verb)) {
            continue;
        }
        assert.ok(
            match[2] !== undefined,
            "found a route registration this test's regex does not understand: this.expressApp." + verb + "(...) - widen REGISTRATION",
        );
        routes.push(verb.toUpperCase() + " " + match[3]);
    }
    return routes;
}

function readmeRoutes() {
    const section = readme.split(/^## /m).find(s => s.startsWith("Endpoints"));
    assert.ok(section, "README has no ## Endpoints section");
    const routes = [];
    for (const line of section.split("\n")) {
        const match = line.match(/^\|\s*`([A-Z]+)`\s*\|\s*`([^`]+)`\s*\|/);
        if (match) {
            routes.push(match[1] + " " + match[2]);
        }
    }
    return routes;
}

const EXPECTED_ROUTES = [
    "GET /session/:sessionId",
    "POST /session/new",
    "GET /project/:projectName",
    "GET /script/:scriptId",
    "GET /project/:projectName/session/:sessionId/recfile",
    "GET /project/:projectName/session/:sessionId/recfile/:itemCode/:version",
    "GET /project/:projectName/resources/images/:imageFile",
    "POST /session/:sessionId/recfile/:itemCode",
    "PATCH /project/:projectName/session/:sessionId",
];

test("src/main.js registers exactly the expected nine routes", () => {
    assert.deepEqual(registeredRoutes(mainSource).sort(), [...EXPECTED_ROUTES].sort());
    assert.equal(EXPECTED_ROUTES.length, 9, "README and the proxy config describe exactly nine routes");
});

test("the README endpoint table lists exactly the registered routes", () => {
    assert.deepEqual(readmeRoutes().sort(), registeredRoutes(mainSource).sort());
});
