/**
 * This is the handler module which provides the neccessary functionality for the visp system.
 * It provides GitLab integration by pushing all the recorded/uploaded audio directly to GitLab.
 * As well as notifies the visp backend of the session completion.
 */

import axios from "axios";
import { default as fs } from "fs";

class VispHandler {
    constructor(app) {
        this.app = app;
        this.name = 'Visp';
    }
    
    handle(eventType, data = null) {
        switch(eventType) {
            case "sessionComplete":
                this.importSessionAudioFiles(data);
                break;
            case "sessionFileUpload":
                this.sessionFileUpload(data);
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
            console.log("Creating destination path directories");
            for(let i = 0; i < destinationPathParts.length - 1; i++) {
                currentPath += destinationPathParts[i]+"/";
                if (!fs.existsSync(currentPath)){
                    fs.mkdirSync(currentPath);
                }
            }

            console.log("Moving file from "+sourceFilePath+" to "+destinationPath);

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

            console.log('File moved successfully!');
        } catch (err) {
            console.error('Error moving file:', err);
        }
    }

    importSessionAudioFiles(data) {
        //this recording session is now complete, which means we need to import the audio files into the project
        this.app.addLog("Session is now complete, tell the session-manager to import audio files", "debug");

        let postData = {
            projectId: data.projectName,
            sessionId: data.session.sessionId
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