import { default as dotenv } from "dotenv";
import { default as fs } from "fs";
import { default as path } from "path";
import { default as colors } from "colors";
import { default as express } from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { default as http } from "http";
import { nanoid } from "nanoid";
import { default as mongodb } from "mongodb";

const version = "1.1.0";

const SHUTDOWN_TIMEOUT_MS = 5000;

// Item codes come from the URL and end up in filesystem paths, so only allow
// the characters SPR script item codes actually use (e.g. "prompt_1").
const ITEM_CODE_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

// Project ids and session ids are client supplied too, and they end up in
// filesystem paths as well, so they get the same character gate.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

class WebSpeechRecorderServer {
	constructor() {
		dotenv.config();
		colors.enable();
		this.handlerModules = [];
		this.logFile = typeof process.env.LOG_PATH != "undefined" ? process.env.LOG_PATH : "./logs/wsrng-server.log";
		this.enbledModules = typeof process.env.ENABLED_MODULES != "undefined" ? JSON.parse(process.env.ENABLED_MODULES) : [];
		this.addLog('Starting WebSpeechRecorderServer '+version);
		this.serverPort = process.env.SERVER_PORT;

		this.importHandlerModules();

		this.expressApp = express();
		this.expressApp.use(bodyParser.json({ type: "application/json" }));
		this.expressApp.use(bodyParser.raw({ type: "audio/wav", limit: "200mb" }));
		this.expressApp.use(cookieParser());

		this.db = null;
		this.connectToMongo().then(async (db) => {
			this.db = db;
			this.addLog("Connected to MongoDB");
			this.mongoCreateCollections();
			//this.purgeDatabase();
			this.setupEndpoints();
		}).catch(reason => {
			this.addLog("Failed connecting to MongoDB", "error");
		});
		
		this.server = this.expressApp.listen(this.serverPort, () => {
			this.addLog(`WebSpeechRecorderServer listening on port ${this.serverPort}`);
		});

		process.on('SIGTERM', () => this.shutdown('SIGTERM'));
		process.on('SIGINT', () => this.shutdown('SIGINT'));
	}

	// server.close() alone never lets the process exit: it waits for idle
	// keep-alive sockets, and the open Mongo connection keeps the event loop alive
	// regardless. Podman then SIGKILLs us after its stop timeout and systemd marks
	// the unit failed. So drop the sockets, close Mongo, and exit explicitly, with
	// a hard deadline in case anything hangs.
	shutdown(signal) {
		if(this.shuttingDown) {
			return;
		}
		this.shuttingDown = true;
		this.addLog(signal+' signal received: closing WebSpeechRecorderServer');

		setTimeout(() => {
			this.addLog('Graceful shutdown timed out, forcing exit', 'warn');
			process.exit(1);
		}, SHUTDOWN_TIMEOUT_MS).unref();

		this.server.close(async () => {
			try {
				await this.disconnectFromMongo();
			}
			catch(error) {
				this.addLog('Error closing MongoDB connection: '+error, 'warn');
			}
			this.addLog('Shutdown');
			process.exit(0);
		});
		this.server.closeIdleConnections();
		// In-flight uploads get a moment to finish before being cut off.
		setTimeout(() => this.server.closeAllConnections(), 2000).unref();
	}

	importHandlerModules() {
		//Import any handler modules
		const handlerDir = path.join('./src', 'handler_modules');
		fs.readdirSync(handlerDir).forEach(file => {
			let moduleName = file.split(".")[0];
			if(this.enbledModules.includes(moduleName)) {
				import("./handler_modules/"+file).then(handler => {
					let module = new handler.default(this);
					this.handlerModules.push(module);
					this.addLog("Handler module "+module.name+" imported");
				});
			}
		});
	}

	invokeHandlerModules(eventType, data) {
		if(this.handlerModules.length == 0) {
			this.addLog("Fired event "+eventType+" but no handler modules loaded", "warn");
			return;
		}
		this.handlerModules.forEach(module => {
			module.handle(eventType, data);
		});
	}

	setupEndpoints() {
		this.expressApp.use((req, res, next) => {
			this.addLog(req.method+" "+req.path);
			next();
		});
		
		this.expressApp.get("/session/:sessionId", async (req, res) => {
			let session = await this.getSession(req.params.sessionId);

			if(!session) {
				res.status(404);
				res.end("Session '"+req.params.sessionId+"' not found");
				return;
			}

			//if this is a completed session, set it to loaded here instead
			//this is because if we tell the spr client that this session is already completed,
			//it will not send the COMPLETED status patch request when the session is completed
			//and thus we will not know when recording have finished
			if(session.status == "COMPLETED") {
				session.status = "LOADED";
			}

			if(session) {
				res.end(JSON.stringify(session, null, 2));
			}
			else {
				res.status(404);
				res.end();
			}
		});

		this.expressApp.post("/session/new", async (req, res) => {
			let sprSessionConfig = req.body;
			//Both of these fields are later concatenated into filesystem paths, so
			//refuse anything that is not a plain id before it is ever stored.
			if((typeof sprSessionConfig.project != "undefined" && !ID_PATTERN.test(String(sprSessionConfig.project)))
				|| (typeof sprSessionConfig.sessionId != "undefined" && !ID_PATTERN.test(String(sprSessionConfig.sessionId)))) {
				this.addLog("Rejected session config with an invalid project or sessionId", "warn");
				res.status(400).end();
				return;
			}
			let session = await this.createSession(sprSessionConfig);
			res.end(JSON.stringify(session, null, 2));
		});

		this.expressApp.get("/project/:projectName", async (req, res) => {
			let project = await this.getProject(req.params.projectName);
			if(project) {
				res.end(JSON.stringify(project, null, 2));
			}
			else {
				res.status(404);
				res.end();
			}
		});

		this.expressApp.get("/script/:scriptId", async (req, res) => {
			let script = await this.getScript(req.params.scriptId);
			if(script) {
				res.end(JSON.stringify(script, null, 2));
			}
			else {
				res.status(404);
				res.end();
			}
		});

		this.expressApp.get("/project/:projectName/session/:sessionId/recfile", async (req, res) => {
			let recfile = await this.getRecfile(req.params.projectName, req.params.sessionId);
			if(recfile) {
				res.end(JSON.stringify(recfile, null, 2));
			}
			else {
				res.status(404).end();
			}
		});

		//Audio of an already recorded take, fetched by the SPR client when it shows a
		//prompt that was recorded in an earlier page load. Only the latest take of a
		//prompt is kept, so that is what's served whatever version is asked for.
		//Handler modules may move uploads elsewhere, so they get the first say in
		//where the file lives.
		this.expressApp.get("/project/:projectName/session/:sessionId/recfile/:itemCode/:version", async (req, res) => {
			if(!ITEM_CODE_PATTERN.test(req.params.itemCode)) {
				res.status(400).end();
				return;
			}
			let session = await this.getSession(req.params.sessionId);
			if(!session) {
				res.status(404).end();
				return;
			}
			if(!ID_PATTERN.test(String(session.sessionId)) || !ID_PATTERN.test(String(session.project))) {
				this.addLog("Rejected recfile read for session with an invalid project or sessionId", "warn");
				res.status(400).end();
				return;
			}
			let filePath = this.resolveRecfilePath(session, req.params.itemCode);
			if(!filePath) {
				res.status(404).end();
				return;
			}
			res.sendFile(path.resolve(filePath), { headers: { "Content-Type": "audio/wav" } });
		});

		this.expressApp.get("/project/:projectName/resources/images/:imageFile", async (req, res) => {
			try {
				let image = this.readFile("resources/"+req.params.projectName+"/images/"+req.params.imageFile, false);
				res.end(image);
			}
			catch(error) {
				res.status(404).end();
			}
		});

		//This is an upload of a recorded wav
		this.expressApp.post("/session/:sessionId/recfile/:itemCode", async (req, res) => {
			//this method needs to:
			//1. store the wav provided in a file storage area
			let audioBinary = req.body;
			let fileSequence = 0;
			let itemCode = req.params.itemCode;
			let fileEnding = "wav";
			if(!ITEM_CODE_PATTERN.test(itemCode)) {
				this.addLog("Rejected upload with invalid item code", "warn");
				res.status(400).end();
				return;
			}
			let session = await this.getSession(req.params.sessionId);
			if(!session) {
				res.status(404).end();
				return;
			}
			if(!ID_PATTERN.test(String(req.params.sessionId)) || !ID_PATTERN.test(String(session.project))) {
				this.addLog("Rejected upload with an invalid session or project id", "warn");
				res.status(400).end();
				return;
			}

			let filePath = process.env.AUDIO_FILE_STORAGE_PATH+"/"+session.project+"/Data/speech_recorder_uploads/emudb-sessions/"+req.params.sessionId+"/"+itemCode;
			//let filePath = process.env.AUDIO_FILE_STORAGE_PATH+"/"+session.project+"/Data/unimported_audio/emudb-sessions/"+req.params.sessionId+"/"+itemCode;
			this.mkDir(filePath);
			let dir = fs.readdirSync(filePath);
			dir.sort();
			dir.forEach(d => {
				let number = parseInt(d.split(".")[0]);
				if(number >= fileSequence) {
					fileSequence = number + 1;
				}
			});
			let filename = fileSequence+"."+fileEnding;
			fs.writeFileSync(filePath+"/"+filename, audioBinary);

			let fileDuration = 0; //FIXME: This is always zero, need to find a wav lib which can give us a duration, wav-file-info does not work.
			
			//2. create and store a 'recfile'-type metadata object for this wav
			let recfile = {
				"recordingFileId": fileSequence, //should be the same as the filename without the extension
				"project": session.project, //this is an addition to the standard wsrng-format for this object type, but we need a reference to the project as well to able to find this later
				"session": req.params.sessionId,
				"date" : new Date(),
				"recording" : {
				  "mediaitems" : [ {
					"annotationTemplate" : false,
					"text" : "" //this should be the phrase that is spoken, in text form, can be found in the script
				  } ],
				  "itemcode" : itemCode,
				  "recduration" : fileDuration, //length of the audio in milliseconds
				  "recinstructions" : { //not sure why this is here, since it's also in the script, could perhaps be deleted?
					"recinstructions" : ""
				  }
				}
			}

			await this.createRecfile(recfile);

			this.invokeHandlerModules("sessionFileUpload", {
				audioBinary: audioBinary,
				itemCode: itemCode,
				fileEnding: fileEnding,
				session: session,
				filePath: filePath,
				recfile: recfile
			});

			res.end();
		});

		this.expressApp.patch("/project/:projectName/session/:sessionId", async (req, res) => {
			let session = await this.getSession(req.params.sessionId);
			let patchData = req.body;

			//status can be:
			//CREATED
			//LOADED
			//STARTED
			//COMPLETED

			if(typeof patchData.restartedDate != "undefined" && patchData.restartedDate != "") {
				//this is a restart of an already completed session
				this.invokeHandlerModules("sessionRestarted", {
					projectName: req.params.projectName,
					session: session,
					patchData: patchData
				});

				session.status = "LOADED";
			}

			if(typeof patchData.status != "undefined" && patchData.status == "COMPLETED") {
				this.invokeHandlerModules("sessionComplete", {
					projectName: req.params.projectName,
					session: session,
					patchData: patchData
				});

				session.sealed = true; //sealing the session when completed to prevent further changes
			}

			this.patchObject(session, patchData);
			await this.saveSession(session);

			this.invokeHandlerModules("sessionPatched", {
				session: session,
				patchData: patchData
			});

			res.end();
		});
	}

	async createSession(sprSessionConfig) {
		//Check if this project exists as an SPR-project, otherwise we need to create that first
		let sprProjectConfig = await this.getProject(sprSessionConfig.project);
			
		if(!sprProjectConfig) {
			this.addLog("Will create new SPR project");
			sprProjectConfig = this.createProject({
				name: sprSessionConfig.project
			});
		}
		
		let sprProjectVispId = nanoid();
		sprProjectConfig.vispId = sprProjectVispId;
		let sprProjectConfigJson = JSON.stringify(sprProjectConfig, null, 2);
		
		//We also need create a session in this project
		let sessionId = nanoid();
		let sessionJsonDefaults = {
			"debugMode": true,
			"sessionId": sessionId, //this needs to be a global id - I think!
			"type": "NORM",
			"project": sprProjectConfig.name,
			"status": "CREATED",
			"sealed": false,
			"script": 1245
		};

		//Merge the defaults with the provided config
		Object.keys(sessionJsonDefaults).forEach(k => {
			if(typeof sprSessionConfig[k] == "undefined") {
				sprSessionConfig[k] = sessionJsonDefaults[k];
			}
		});

		await this.db.collection("sessions").insertOne(sprSessionConfig);

		this.addLog("Created new SPR session", "info");

		this.invokeHandlerModules("sessionCreated", {
			session: sprSessionConfig
		});

		return sprProjectConfig;
	}

	async saveSession(session) {
		return await this.db.collection("sessions").replaceOne({ "sessionId": session.sessionId }, session);
	}

	purgeDatabase() {
		this.addLog("Purging database", "warn");
		this.db.collection("projects").deleteMany({});
		this.db.collection("recfiles").deleteMany({});
		this.db.collection("scripts").deleteMany({});
		this.db.collection("sessions").deleteMany({});
	}

	patchObject(original, patchData) {
		let keys = Object.keys(patchData);
		keys.forEach(dataKey => {
			original[dataKey] = patchData[dataKey];
		});
		return original;
	}

	mkDir(dir) {
		try {
			fs.mkdirSync(dir, { recursive: true });
		}
		catch(error) {
			this.addLog(error, "error");
		}
	}

	getRecfileVersionsList(recfileInputDirectoryPath) {
		try {
			return fs.readdirSync(recfileInputDirectoryPath);
		}
		catch(error) {
			if(error.code != "ENOENT") {
				this.addLog(error, "error");
			}
			return [];
		}
	}

	parseCookies(request) {
        var list = {},
            rc = request.headers.cookie;

        rc && rc.split(';').forEach(function( cookie ) {
            var parts = cookie.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
        return list;
    }

	async getProject(sprProjectName) {
		let project = await this.db.collection("projects").findOne({
			"name": parseInt(sprProjectName)
		});

		if(!project) {
			project = {
				name: sprProjectName,
				description: 'No description',
				audioFormat: {
					channels: 1
				},
				speakerWindowShowStopRecordAction: true,
				recordingDeviceWakeLock: true
			};

			await this.db.collection("projects").insertOne(project)
		}

		return project;
	}

	async createRecfile(recFileConfig) {
		await this.db.collection("recfiles").insertOne(recFileConfig);
		this.invokeHandlerModules("createRecfile", recFileConfig);
		return recFileConfig;
	}

	async createProject(projectConfig) {
		let projectJsonDefaults = {
			"description": "No description",
			"name": "Noname",
			"audioFormat" : {
				"channels": 1
			},
			"speakerWindowShowStopRecordAction": true,
			"recordingDeviceWakeLock": true
		};

		Object.keys(projectJsonDefaults).forEach(k => {
			if(typeof projectConfig[k] == "undefined") {
				projectConfig[k] = projectJsonDefaults[k];
			}
		});

		await this.db.collection("projects").insertOne(projectConfig);

		this.invokeHandlerModules("createProject", projectConfig);
		
		return projectConfig;
	}

	//What is called a "recfile" in the wsrng is really a list of objects describing recordings
	//The SPR client uses this list to mark prompts recorded in an earlier page load
	//as done; without it, a reloaded session can only be completed by re-recording
	//every prompt. Recfiles are stored with "project"/"session" keys (see the upload
	//endpoint). The client reads "version" to tell takes apart; recordingFileId
	//can't serve, since it restarts at 0 whenever a handler module moves the
	//uploads away, so takes are numbered per prompt in upload order.
	async getRecfile(projectName, sessionId) {
		const recfilesCollection = this.db.collection("recfiles");
		const recfiles = await recfilesCollection.find({
			"project": projectName,
			"session": sessionId
		}).sort({ "date": 1 }).toArray();
		const takesPerItem = {};
		return recfiles.map(rf => {
			const itemCode = rf.recording?.itemcode;
			takesPerItem[itemCode] = (takesPerItem[itemCode] ?? -1) + 1;
			return { ...rf, version: takesPerItem[itemCode] };
		});
	}

	//Where the latest take of an item lives on disk, or null if it's gone.
	resolveRecfilePath(session, itemCode) {
		for(const module of this.handlerModules) {
			if(typeof module.resolveRecfilePath == "function") {
				const modulePath = module.resolveRecfilePath(session, itemCode);
				if(modulePath) {
					return modulePath;
				}
			}
		}
		const itemDir = process.env.AUDIO_FILE_STORAGE_PATH+"/"+session.project+"/Data/speech_recorder_uploads/emudb-sessions/"+session.sessionId+"/"+itemCode;
		const takes = this.getRecfileVersionsList(itemDir)
			.map(f => parseInt(f.split(".")[0]))
			.filter(n => !isNaN(n));
		if(takes.length == 0) {
			return null;
		}
		return itemDir+"/"+Math.max(...takes)+".wav";
	}

	async getSession(sessionId) {
		const sessionsCollection = this.db.collection("sessions");
		return await sessionsCollection.findOne({
			sessionId: sessionId
		});
	}

	async getScript(scriptId) {
		const sessionsCollection = this.db.collection("scripts");
		return await sessionsCollection.findOne({
			"scriptId": scriptId
		});
	}

	readFile(filePath, text = true) {
		let stats = null;
		try {
			stats = fs.statSync(filePath);
		}
		catch(error) {
			this.addLog(error, "error");
			return null;
		}

		if(stats) {
			let options = {}
			if(text) {
				options.encoding = "utf-8";
			}
			let buf = fs.readFileSync(filePath, options);
			return buf;
		}
	}

	writeFile(filePath, contents) {
		let success = true;
		try {
			fs.writeFileSync(filePath, contents);
			return true;
		}
		catch(error) {
			this.addLog(error, "error");
			return false;
		}
	}

	async connectToMongo() {
		const mongodbUrl = 'mongodb://'+process.env.MONGO_USER+':'+process.env.MONGO_PASSWORD+'@'+process.env.MONGO_HOST+':'+process.env.MONGO_PORT;
        this.mongoClient = new mongodb.MongoClient(mongodbUrl);
        let db = null;
        try {
            await this.mongoClient.connect();
            db = this.mongoClient.db(process.env.MONGO_DATABASE);
			return db;
        } catch(error) {
			throw new Error(error);
        }
    }

    async disconnectFromMongo() {
        if(this.mongoClient != null) {
            await this.mongoClient.close();
        }
    }

	async mongoCreateCollections() {
		let collections = await this.db.collections();
		const sprCollectionPrefix = "";
		const sprCollections = [sprCollectionPrefix+"projects", sprCollectionPrefix+"sessions", sprCollectionPrefix+"recfiles", sprCollectionPrefix+"scripts"];
		collections.forEach(collection => {
			if(sprCollections.includes(collection.collectionName)) {
				sprCollections.splice(sprCollections.indexOf(collection.collectionName), 1);
			}
		});
		sprCollections.forEach(collectionName => {
			this.addLog("MongoDB did not contain the collection "+collectionName+", creating it now.");
			this.db.createCollection(collectionName);
		});
	}

	addLog(msg, level = 'info') {
		let levelMsg = new String(level).toUpperCase();
		if(levelMsg == "DEBUG" && this.logLevel == "INFO") {
		  return;
		}
	
		let levelMsgColor = levelMsg;
	
		if(levelMsg == "WARNING") { levelMsg = "WARN"; }
	
		switch(levelMsg) {
		  case "INFO":
			levelMsgColor = colors.green(levelMsg);
		  break;
		  case "WARN":
			levelMsgColor = colors.yellow(levelMsg);
		  break;
		  case "ERROR":
			levelMsgColor = colors.red(levelMsg);
		  break;
		  case "DEBUG":
			levelMsgColor = colors.cyan(levelMsg);
		  break;
		}
		
		let logMsg = new Date().toLocaleDateString("sv-SE")+" "+new Date().toLocaleTimeString("sv-SE");
		let printMsg = logMsg+" ["+levelMsgColor+"] "+msg;
		let writeMsg = logMsg+" ["+levelMsg+"] "+msg+"\n";

		switch(level) {
		  case 'info':
			console.log(printMsg);
			fs.appendFileSync(this.logFile, writeMsg);
			break;
		  case 'warn':
			console.warn(printMsg);
			fs.appendFileSync(this.logFile, writeMsg);
			break;
		  case 'error':
			console.error(printMsg);
			fs.appendFileSync(this.logFile, writeMsg);
			break;
		  default:
			console.error(printMsg);
			fs.appendFileSync(this.logFile, writeMsg);
		}
	  }
}

new WebSpeechRecorderServer();