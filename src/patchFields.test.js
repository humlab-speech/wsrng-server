// node --test src/patchFields.test.js  (no framework, like session-manager's pathSecurity.test.js)
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedPatchFields } from "./patchFields.js";

test("the recorder's own progress report passes through untouched", () => {
    const body = { status: "COMPLETED", completedDate: "2026-10-05T10:00:00Z" };
    assert.deepEqual(allowedPatchFields(body), body);
    assert.deepEqual(allowedPatchFields({ restartedDate: "x" }), { restartedDate: "x" });
});

test("a patch cannot re-point the session or rewrite its identity", () => {
    const dropped = [];
    const kept = allowedPatchFields(
        { script: "another-script", sealed: false, _id: "x", sessionId: "someone-elses-session", project: "other", status: "STARTED" },
        (field) => dropped.push(field),
    );
    assert.deepEqual(kept, { status: "STARTED" });
    assert.deepEqual(dropped.sort(), ["_id", "project", "script", "sealed", "sessionId"]);
});

test("a body that is not an object writes nothing", () => {
    assert.deepEqual(allowedPatchFields(undefined), {});
    assert.deepEqual(allowedPatchFields("script=evil"), {});
});
