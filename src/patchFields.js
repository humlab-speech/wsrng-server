/**
 * Which fields a session progress report may write to a session document.
 *
 * The PATCH route has no authentication of its own - participants open the
 * recorder link without ever logging in - so the request body cannot be trusted
 * to name fields. Anything outside this list is dropped by the caller.
 *
 * "script" is deliberately absent: item codes name the recorded takes and every
 * script numbers its prompts from prompt_1, so moving a session that already has
 * recordings onto another script makes the next participant record over takes that
 * belong to other prompts. session-manager refuses the same move on a project save.
 * "sealed", "_id", "sessionId" and "project" are absent for the same reason - they
 * are set by this server, not reported by the recorder.
 */
export const PATCHABLE_FIELDS = ["status", "loadedDate", "startedDate", "completedDate", "restartedDate"];

/**
 * Returns only the patchable entries of `body`; unrecognised ones are reported so a
 * future recorder version that sends something new shows up in the log instead of
 * being silently ignored forever.
 */
export function allowedPatchFields(body, onDropped = () => {}) {
	if (body == null || typeof body != "object") {
		return {};
	}
	const allowed = {};
	for (const field of Object.keys(body)) {
		if (PATCHABLE_FIELDS.includes(field)) {
			allowed[field] = body[field];
		} else {
			onDropped(field);
		}
	}
	return allowed;
}
