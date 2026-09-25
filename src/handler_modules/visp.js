/**
 * This is the handler module which provides the neccessary functionality for the visp system.
 * It provides GitLab integration by pushing all the recorded/uploaded audio directly to GitLab.
 * As well as notifies the visp backend of the session completion.
 */

import axios from "axios";
import { default as fs } from "fs";

// Fallback delay after a session is marked COMPLETED. Normally the import is
// triggered the instant the last expected file lands (see the completion
// barrier below); this timer is only a safety net for sessions completed with
// fewer recordings than prompts (e.g. a skipped prompt), so the import never
// hangs waiting for a file that will never arrive.
const IMPORT_FALLBACK_MS = 10000;

class VispHandler {
    constructor(app) {
        this.app = app;
        this.name = 'Visp';
        // Per-session completion barriers, keyed by sessionId. Lets us import the
        // moment the final expected file has been moved into place instead of
        // racing the SPR client, which sends COMPLETED before its last upload.
        this.pendingImports = new Map();
    }

    handle(eventType, data = null) {
        switch(eventType) {
            case "sessionComplete":
                this.onSessionComplete(data);
                break;
            case "sessionFileUpload":
                this.sessionFileUpload(data);
                // A file just landed; if its session is awaiting import, this may
                // be the last one we were waiting for.
                this.maybeImport(data.session);
                break;
        }
    }

    sessionFileUpload(data) {
        this.app.addLog("Session file upload", "info");

        let projectId = data.session.project;
        let sessionId = data.session.sessionId;

        let sourceDirectory = data.filePath;
        let destinationPath = "/repositories/"+projectId+"/Data/speech_recorder_uploads/emudb-sessions/"+sessionId+"/"+data.itemCode+"."+data.fileEnding;
        
        try {
            //move the latest file to the destination
            //the files will be named: 0.wav, 1.wav, 2.wav, etc.

            //check if the destination folder exists
            let destinationFolder = destinationPath.substring(0, destinationPath.lastIndexOf("/"));
            if (!fs.existsSync(destinationFolder)){
                fs.mkdirSync(destinationFolder, { recursive: true });
            }

            //scan data.filePath for the latest file
            let latestFile = 0;
            let files = fs.readdirSync(sourceDirectory);
            files.forEach(file => {
                let fileNumber = parseInt(file.substring(0, file.lastIndexOf(".")));
                if(fileNumber > latestFile) {
                    latestFile = fileNumber;
                }
            });

            let sourceFilePath = sourceDirectory+"/"+latestFile+"."+data.fileEnding;

            //create all the directories in the destination path
            let destinationPathParts = destinationPath.split("/");
            let currentPath = "";
            this.app.addLog("Creating destination path directories", "debug");
            for(let i = 0; i < destinationPathParts.length - 1; i++) {
                currentPath += destinationPathParts[i]+"/";
                if (!fs.existsSync(currentPath)){
                    fs.mkdirSync(currentPath);
                }
            }

            this.app.addLog("Moving file from "+sourceFilePath+" to "+destinationPath, "debug");

            //we do not use fs.renameSync because it does not work across different filesystems
            try {
                // Copy the file
                fs.copyFileSync(sourceFilePath, destinationPath);
                //console.log(`File copied to ${destinationPath}`);
                
                // Delete the original file
                fs.unlinkSync(sourceFilePath);
                //console.log(`Original file deleted at ${sourceFilePath}`);
            } catch (error) {
                console.error(`Error moving file:`, error);
            }

            this.app.addLog("File moved successfully", "debug");
        } catch (err) {
            this.app.addLog("Error moving file: "+err, "error");
        }
    }

    async onSessionComplete(data) {
        const session = data.session;
        const sessionId = session.sessionId;

        // The SPR client sends the COMPLETED status before its final file finishes
        // uploading, so we cannot import right here. Instead we register a barrier:
        // import as soon as every expected file has arrived (checked here and on
        // each subsequent sessionFileUpload), with a short fallback in case some
        // prompts were never recorded.
        const entry = {
            expected: null,
            triggered: false,
            fallbackTimer: null,
            projectId: session.project,
            sessionId: sessionId,
        };
        this.pendingImports.set(sessionId, entry);

        // Arm the fallback first, so a failure to read the script (expected stays
        // null) still results in an import.
        entry.fallbackTimer = setTimeout(() => {
            this.app.addLog("Import barrier fallback fired for session " + sessionId + " (expected count not reached in time)", "warn");
            this.triggerImport(entry);
        }, IMPORT_FALLBACK_MS);

        entry.expected = await this.countExpectedPrompts(session);
        this.app.addLog("Session " + sessionId + " complete; expecting " + entry.expected + " recording(s) before import", "debug");

        // Files may have arrived while we were reading the script.
        this.maybeImport(session);
    }

    // Number of prompts defined in this session's script. Walks the SPR script
    // structure: sections[].groups[].promptItems[]. Returns 0 if it can't be
    // determined, which defers to the fallback timer rather than importing early.
    async countExpectedPrompts(session) {
        try {
            const script = await this.app.getScript(session.script);
            if(!script || !Array.isArray(script.sections)) {
                return 0;
            }
            let count = 0;
            script.sections.forEach(section => {
                (section.groups || []).forEach(group => {
                    count += (group.promptItems || []).length;
                });
            });
            return count;
        } catch(error) {
            this.app.addLog("Could not read script for session " + session.sessionId + ": " + error, "error");
            return 0;
        }
    }

    // Number of distinct prompts uploaded so far for this session. We count the
    // moved files in the repository destination dir, where sessionFileUpload keeps
    // exactly one <itemcode>.wav per prompt (latest version only), so re-recording
    // a prompt never inflates this count.
    countUploadedFiles(session) {
        const destDir = "/repositories/" + session.project + "/Data/speech_recorder_uploads/emudb-sessions/" + session.sessionId;
        try {
            if(!fs.existsSync(destDir)) {
                return 0;
            }
            return fs.readdirSync(destDir).filter(f => f !== "." && f !== "..").length;
        } catch(error) {
            this.app.addLog("Could not count uploaded files for session " + session.sessionId + ": " + error, "error");
            return 0;
        }
    }

    // Trigger the import if every expected file is now present. No-op if there is
    // no barrier for this session, it already fired, or files are still missing.
    maybeImport(session) {
        if(!session || !session.sessionId) {
            return;
        }
        const entry = this.pendingImports.get(session.sessionId);
        if(!entry || entry.triggered) {
            return;
        }
        if(entry.expected > 0 && this.countUploadedFiles(session) >= entry.expected) {
            this.triggerImport(entry);
        }
    }

    // Tell the session-manager to import this session's audio. Single-fire: clears
    // the barrier so neither a late upload nor the fallback timer can re-trigger.
    triggerImport(entry) {
        if(entry.triggered) {
            return;
        }
        entry.triggered = true;
        if(entry.fallbackTimer) {
            clearTimeout(entry.fallbackTimer);
            entry.fallbackTimer = null;
        }
        this.pendingImports.delete(entry.sessionId);

        this.app.addLog("Session is now complete, tell the session-manager to import audio files", "debug");

        let postData = {
            projectId: entry.projectId,
            sessionId: entry.sessionId
        };

        axios.post("http://session-manager:8080/api/importaudiofiles", postData, {
            headers: {
                'Content-Type': 'application/json'
            }
        }).then(response => {
            console.log(response.status, response.statusText, response.data);
        }).catch(error => {
            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                console.log(error.response.status, error.response.statusText, error.response.data);
            } else if (error.request) {
                // The request was made but no response was received
                // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                // http.ClientRequest in node.js
                console.log('No response received:', error.request);
            } else {
                // Something happened in setting up the request that triggered an Error
                console.log('Error', error.message);
            }
            console.log('Error config:', error.config);
        });
    }

    async getPhpSession(request) {
		let cookies = this.parseCookies(request);
        let phpSessionId = cookies.PHPSESSID;

        //this.app.addLog('Validating phpSessionId '+phpSessionId);

        let options = {
            headers: {
                'Cookie': "PHPSESSID="+phpSessionId
            }
        }

        return new Promise((resolve, reject) => {
            http.get("http://apache/api/api.php?f=session", options, (incMsg) => {
                let body = "";
                incMsg.on('data', (data) => {
                    body += data;
				});
                incMsg.on('end', () => {
                    try {
                        let responseBody = JSON.parse(body);
                        if(responseBody.body == "[]") {
                            this.app.addLog("User not identified");
                            resolve({
                                authenticated: false
                            });
                            return;
                        }
                    }
                    catch(error) {
                        this.app.addLog("Failed parsing authentication response data", "error");
                        resolve({
                            authenticated: false
                        });
                        return;
                    }

                    let userSession = JSON.parse(JSON.parse(body).body);
                    if(typeof userSession.username == "undefined") {
                        resolve({
                            authenticated: false
                        });
                        return;
                    }
                    resolve({
                        authenticated: true,
                        userSession: userSession
                    });
                });
            });
        });
	}
}

export default VispHandler;