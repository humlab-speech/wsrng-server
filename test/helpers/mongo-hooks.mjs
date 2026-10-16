// Module-resolution hook: redirect every bare "mongodb" import to the
// in-memory stub, so the server can be started end-to-end without a database.
const STUB_URL = new URL("./mongo-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "mongodb") {
		return { url: STUB_URL, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
