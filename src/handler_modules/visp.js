/**
 * This is the handler module which provides the neccessary functionality for the visp system.
 * It provides GitLab integration by pushing all the recorded/uploaded audio directly to GitLab.
 * As well as notifies the visp backend of the session completion.
 */

import axios from "axios";
import { default as fs } from "fs";

// How often, and how far apart, to retry telling the session-manager that a
// session needs an import check. The hint only speeds things up: the
// session-manager also polls upload directories and imports anything that
// hasn't been imported yet, so a hint that never arrives just means a later import.
const IMPORT_HINT_RETRY_DELAYS_MS = [2000, 10000, 30000];

class VispHandler {
    constructor(app) {
        this.app = app;
        this.name = 'Visp';
    }

    handle(eventType, data = null) {
        switch(eventType) {
            case "sessionComplete":
                this.requestImportCheck(data.session);
                break;
            case "sessionFileUpload":
                this.sessionFileUpload(data);
                // A re-take after completion (or the final upload, which the SPR
                // client sends after COMPLETED) changes what should be imported.
                if(data.session.sealed) {
                    this.requestImportCheck(data.session);
                }
                break;
        }
    }

    // Where sessionFileUpload keeps the latest take of each prompt.
    sessionUploadDir(session) {
        return "/repositories/"+session.project+"/Data/speech_recorder_uploads/emudb-sessions/"+session.sessionId;
    }

    resolveRecfilePath(session, itemCode) {
        const filePath = this.sessionUploadDir(session)+"/"+itemCode+".wav";
        return fs.existsSync(filePath) ? filePath : null;
    }

    sessionFileUpload(data) {
        this.app.addLog("Session file upload", "info");

        let destinationFolder = this.sessionUploadDir(data.session);
        let destinationPath = destinationFolder+"/"+data.itemCode+"."+data.fileEnding;

        try {
            fs.mkdirSync(destinationFolder, { recursive: true });

            //the upload endpoint numbers takes 0.wav, 1.wav, ...; move the newest one
            let latestFile = 0;
            fs.readdirSync(data.filePath).forEach(file => {
                let fileNumber = parseInt(file.substring(0, file.lastIndexOf(".")));
                if(fileNumber > latestFile) {
                    latestFile = fileNumber;
                }
            });
            let sourceFilePath = data.filePath+"/"+latestFile+"."+data.fileEnding;

            this.app.addLog("Moving file from "+sourceFilePath+" to "+destinationPath, "debug");

            //Copy to a temp name and rename into place, so the session-manager's
            //import never picks up a half-written file. (A plain rename would not
            //work: the source is on a different filesystem.)
            let tempPath = destinationFolder+"/."+data.itemCode+"."+data.fileEnding+".tmp";
            fs.copyFileSync(sourceFilePath, tempPath);
            fs.renameSync(tempPath, destinationPath);
            fs.unlinkSync(sourceFilePath);

            this.app.addLog("File moved successfully", "debug");
        } catch (err) {
            this.app.addLog("Error moving file: "+err, "error");
        }
    }

    // Tell the session-manager to check this session for audio that needs
    // importing. It decides when the uploads have settled, so this can be sent
    // before the final file lands.
    async requestImportCheck(session, attempt = 0) {
        const postData = {
            projectId: session.project,
            sessionId: session.sessionId
        };
        try {
            await axios.post("http://session-manager:8080/api/importaudiofiles", postData, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
            });
            this.app.addLog("Requested import check for session "+session.sessionId, "debug");
        } catch(error) {
            const reason = error.response ? "HTTP "+error.response.status : error.message;
            if(attempt < IMPORT_HINT_RETRY_DELAYS_MS.length) {
                this.app.addLog("Import check request for session "+session.sessionId+" failed ("+reason+"), retrying", "warn");
                setTimeout(() => this.requestImportCheck(session, attempt + 1), IMPORT_HINT_RETRY_DELAYS_MS[attempt]);
            }
            else {
                this.app.addLog("Import check request for session "+session.sessionId+" failed ("+reason+"); the session-manager will pick it up on its next scan", "warn");
            }
        }
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