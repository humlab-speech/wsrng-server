// End-to-end regression tests for the HTTP surface of src/main.js (finding F4):
//
//   (a) a malformed JSON body must be answered with a JSON error (no Express
//       HTML page, no stack trace);
//   (b) GET /project/:name must create at most ONE projects document per name
//       (the pre-fix lookup compared name against parseInt(name), so a
//       non-numeric name never matched and every GET inserted a duplicate);
//   (c) POST /session/new must reject non-string sessionId/project values
//       (numbers, arrays, null, Mongo operator objects such as {"$ne":null})
//       with 400 instead of storing them verbatim.
//
// Like the other test files this needs no database and no free-port luck:
// the real server is started as a child process with the mongodb driver
// replaced by test/helpers/mongo-stub.mjs (module-resolution hook), and the
// stub dumps every stored document to a file the test then asserts against.
//
// Run: npm test   (or, without a local Node 24:
//   podman run --rm -v "$PWD:/app" -w /app docker.io/library/node:24.16.0-alpine3.22 \
//     sh -c 'npm install --no-audit --silent && node --test "test/*.test.js"')
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const helpers = path.join(root, "test", "helpers");

let child = null;
let base = null;
let dumpPath = null;
let childOut = null;

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function post(pathname, body, contentType = "application/json") {
	return fetch(base + pathname, {
		method: "POST",
		headers: { "content-type": contentType },
		body,
	});
}

function readStore() {
	if (!existsSync(dumpPath)) {
		return { projects: [], sessions: [] };
	}
	return JSON.parse(readFileSync(dumpPath, "utf8"));
}

before(async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "wsrng-http-test-"));
	dumpPath = path.join(dir, "store.json");
	const opsPath = path.join(dir, "ops.jsonl");
	const logPath = path.join(dir, "server.log");
	childOut = path.join(dir, "child.out");
	const port = await freePort();
	base = "http://127.0.0.1:" + port;

	child = spawn(
		process.execPath,
		["--import", pathToFileURL(path.join(helpers, "register-mongo-stub.mjs")).href, "src/main.js"],
		{
			cwd: root,
			env: {
				...process.env,
				SERVER_PORT: String(port),
				LOG_PATH: logPath,
				MONGO_STUB_OPS: opsPath,
				MONGO_STUB_DUMP: dumpPath,
				ENABLED_MODULES: "[]",
				AUDIO_FILE_STORAGE_PATH: dir,
			},
			stdio: ["ignore", openSync(childOut, "a"), openSync(childOut, "a")],
		},
	);

	// Routes are registered only after (stub-)Mongo connects; the server logs
	// "Connected to MongoDB" synchronously before calling setupEndpoints().
	const deadline = Date.now() + 15000;
	for (;;) {
		if (child.exitCode !== null) {
			assert.fail("server exited early (" + child.exitCode + "):\n" + readFileSync(childOut, "utf8"));
		}
		if (existsSync(logPath) && readFileSync(logPath, "utf8").includes("Connected to MongoDB")) {
			break;
		}
		if (Date.now() > deadline) {
			assert.fail("server did not connect within 15s:\n" + readFileSync(childOut, "utf8"));
		}
		await new Promise(r => setTimeout(r, 25));
	}
});

after(async () => {
	if (child && child.exitCode === null) {
		child.kill("SIGTERM");
		const deadline = Date.now() + 8000;
		while (child.exitCode === null && Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 50));
		}
		if (child.exitCode === null) {
			child.kill("SIGKILL");
		}
	}
});

test("(a) malformed JSON is answered with JSON, not an HTML stack page", async () => {
	const res = await post("/session/new", '{"sessionId":"broken",,}');
	assert.ok(res.status >= 400 && res.status <= 499, "expected 4xx, got " + res.status);
	const text = await res.text();
	assert.match(res.headers.get("content-type") || "", /application\/json/,
		"error body must be JSON, got: " + text.slice(0, 120));
	assert.ok(!text.includes("<"), "error body must not be HTML, got: " + text.slice(0, 120));
	assert.doesNotMatch(text, /node_modules|\.js:\d+/, "error body must not leak a stack trace: " + text.slice(0, 200));
	assert.ok(typeof JSON.parse(text) === "object");
});

test("(b) GET /project/:name answers without creating anything", async () => {
	//The pre-fix lookup compared name against parseInt(name), never matched, and
	//inserted a document per request. Deduplicating the insert would still leave
	//a GET creating state; the endpoint is now read-only and answers an unknown
	//project from the defaults instead.
	for (let i = 0; i < 3; i++) {
		const res = await fetch(base + "/project/f4-readonly-proj");
		assert.equal(res.status, 200);
		const project = JSON.parse(await res.text());
		assert.equal(project.name, "f4-readonly-proj");
		assert.equal(project.audioFormat.channels, 1);
	}
	assert.equal(readStore().projects.filter(p => p.name === "f4-readonly-proj").length, 0,
		"a GET must not create a projects document at all");
});

test("(c) POST /session/new rejects non-string sessionId/project with 400", async () => {
	const payloads = [
		["operator object", { sessionId: { $ne: null }, project: "f4-type-proj" }],
		["number", { sessionId: 123, project: "f4-type-proj" }],
		["array", { sessionId: ["a", "b"], project: "f4-type-proj" }],
		["null", { sessionId: null, project: "f4-type-proj" }],
		["nested operator project", { sessionId: "f4-ok-name", project: { $gt: "" } }],
	];
	for (const [label, body] of payloads) {
		const res = await post("/session/new", JSON.stringify(body));
		assert.equal(res.status, 400, "expected 400 for sessionId of type " + label);
		await res.text();
	}
	const store = readStore();
	const junk = store.sessions.filter(s =>
		typeof s.sessionId !== "string" || typeof s.project !== "string");
	assert.equal(junk.length, 0,
		"non-string sessionId/project must never reach the database: " + JSON.stringify(junk));
	assert.equal(store.projects.filter(p => p.name === "f4-type-proj").length, 0,
		"a rejected create must not leave a project document behind");
});

test("sanity: a normal session creation still works end to end", async () => {
	const res = await post("/session/new", JSON.stringify({ sessionId: "f4 valid session", project: "f4-sane-proj" }));
	const text = await res.text();
	assert.equal(res.status, 200, "valid create must succeed: " + text);
	const project = JSON.parse(text);
	assert.equal(project.name, "f4-sane-proj");

	const store = readStore();
	const sessions = store.sessions.filter(s => s.sessionId === "f4 valid session");
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].project, "f4-sane-proj");
	assert.equal(store.projects.filter(p => p.name === "f4-sane-proj").length, 1);

	const get = await fetch(base + "/session/" + encodeURIComponent("f4 valid session"));
	assert.equal(get.status, 200);
	assert.equal(JSON.parse(await get.text()).sessionId, "f4 valid session");
});

test("(d) POST /session/new is what provisions a project the read cannot find", async () => {
	//The read path is now honest, so this is the only thing that creates a
	//projects document. It has to be awaited: an unawaited createProject hands
	//back a Promise, projectJsonDefaults.project (sprProjectConfig.name) becomes
	//undefined, and the session is stored belonging to no project while the
	//insert lands whenever the microtask queue feels like it.
	const res = await post("/session/new", JSON.stringify({
		sessionId: "f4-provision-session",
		project: "f4-provision-proj",
	}));
	const text = await res.text();
	assert.equal(res.status, 200, "valid create must succeed: " + text);
	assert.equal(JSON.parse(text).name, "f4-provision-proj", "the route answers with the project");

	const store = readStore();
	const sessions = store.sessions.filter(s => s.sessionId === "f4-provision-session");
	assert.equal(sessions.length, 1, "the session must be stored");
	assert.equal(sessions[0].project, "f4-provision-proj",
		"the stored session must belong to the project it was created for");

	const docs = store.projects.filter(pp => pp.name === "f4-provision-proj");
	assert.equal(docs.length, 1, "POST provisions exactly one projects document, found " + docs.length);
});
