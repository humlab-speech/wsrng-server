// Minimal in-memory stand-in for the `mongodb` driver, used by
// test/http.test.js via a module-resolution hook (test/helpers/mongo-hooks.mjs).
// It implements only what src/main.js actually touches:
//   new MongoClient(url) / connect() / db() / close()
//   db.collections() / db.createCollection() / db.collection()
//   collection.findOne / insertOne / findOneAndUpdate($setOnInsert, upsert)
//   collection.replaceOne / find().sort().toArray()
// Documents are deep-copied on store and on read, like a real server-side
// store, so callers cannot mutate what a later read returns.
//
// Every write is also:
//   - appended as one JSON line to process.env.MONGO_STUB_OPS (audit trail)
//   - followed by a full dump of all collections to process.env.MONGO_STUB_DUMP
// so the test process (a different process than the spawned server) can
// assert on what was actually stored.
import fs from "node:fs";

const OPS_PATH = process.env.MONGO_STUB_OPS;
const DUMP_PATH = process.env.MONGO_STUB_DUMP;

const collections = new Map(); // name -> array of stored docs
let idCounter = 0;

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// JSON-based equality: enough for the scalar filters main.js uses and, like
// real Mongo, a NaN filter value never matches a string-stored name
// (JSON.stringify(NaN) === "null", stringify("x") === '"x"').
function eq(a, b) {
	return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

function matches(doc, filter) {
	return Object.entries(filter || {}).every(([key, value]) => eq(doc[key], value));
}

function record(op, payload) {
	if (OPS_PATH) {
		fs.appendFileSync(OPS_PATH, JSON.stringify({ op, ...payload }) + "\n");
	}
}

function dump() {
	if (DUMP_PATH) {
		const all = {};
		for (const [name, docs] of collections) {
			all[name] = docs;
		}
		fs.writeFileSync(DUMP_PATH, JSON.stringify(all));
	}
}

class StubCollection {
	constructor(name) {
		this.name = name;
		if (!collections.has(name)) {
			collections.set(name, []);
		}
	}

	get docs() {
		return collections.get(this.name);
	}

	async findOne(filter) {
		record("findOne", { c: this.name, f: clone(filter) });
		const doc = this.docs.find(d => matches(d, filter));
		return doc === undefined ? null : clone(doc);
	}

	async insertOne(doc) {
		const stored = clone(doc);
		if (stored._id === undefined) {
			stored._id = "stub" + ++idCounter;
		}
		this.docs.push(stored);
		record("insertOne", { c: this.name, d: clone(doc) });
		dump();
		return { acknowledged: true, insertedId: stored._id };
	}

	async findOneAndUpdate(filter, update, options = {}) {
		record("findOneAndUpdate", { c: this.name, f: clone(filter), u: clone(update), upsert: !!options.upsert });
		let doc = this.docs.find(d => matches(d, filter));
		if (!doc) {
			if (!options.upsert) {
				return { value: null, ok: 1 };
			}
			// Upsert insert: equality fields from the filter + $setOnInsert.
			doc = {};
			for (const [key, value] of Object.entries(filter || {})) {
				if (value === null || typeof value != "object") {
					doc[key] = value;
				}
			}
			Object.assign(doc, clone(update["$setOnInsert"]) || {});
			if (doc._id === undefined) {
				doc._id = "stub" + ++idCounter;
			}
			this.docs.push(doc);
			dump();
		}
		// $setOnInsert on an existing document is a no-op, nothing else is supported.
		return { value: clone(doc), ok: 1 };
	}

	async replaceOne(filter, doc) {
		const i = this.docs.findIndex(d => matches(d, filter));
		if (i < 0) {
			return { acknowledged: true, modifiedCount: 0 };
		}
		const stored = clone(doc);
		stored._id = this.docs[i]._id; // a replacement never changes the key
		this.docs[i] = stored;
		record("replaceOne", { c: this.name, f: clone(filter) });
		dump();
		return { acknowledged: true, modifiedCount: 1 };
	}

	find(filter) {
		const docs = this.docs.filter(d => matches(d, filter));
		return {
			sort() {
				return { toArray: async () => clone(docs) };
			},
		};
	}
}

class StubDb {
	collection(name) {
		return new StubCollection(name);
	}

	async collections() {
		return [...collections.keys()].map(collectionName => ({ collectionName }));
	}

	async createCollection(name) {
		if (!collections.has(name)) {
			collections.set(name, []);
			dump();
		}
	}
}

export class MongoClient {
	constructor(url) {
		this.url = url;
	}

	async connect() {}

	db() {
		return new StubDb();
	}

	async close() {}
}

export default { MongoClient };
