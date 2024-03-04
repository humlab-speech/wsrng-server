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

    importSessionAudioFiles(data) {
        //this recording session is now complete, which means we need to import the audio files into the project
        this.app.addLog("Session is now complete, tell the session-manager to import audio files", "debug");
        /*
        data = {
visp-wsrng-server-1  |   projectName: '9j73uDStG08-8eV4_fRdR',
visp-wsrng-server-1  |   session: {
visp-wsrng-server-1  |     _id: new ObjectId("65684f3450e7a28270f0c48c"),
visp-wsrng-server-1  |     project: '9j73uDStG08-8eV4_fRdR',
visp-wsrng-server-1  |     sessionId: 'IoboULTJ33CgwXWdZk-C6',
visp-wsrng-server-1  |     script: 'WOcsu5KqttZnQJl3GEuuY',
visp-wsrng-server-1  |     debugMode: false,
visp-wsrng-server-1  |     type: 'NORM',
visp-wsrng-server-1  |     status: 'LOADED',
visp-wsrng-server-1  |     sealed: false,
visp-wsrng-server-1  |     loadedDate: '2023-11-30T09:00:36.530Z',
visp-wsrng-server-1  |     restartedDate: '2023-11-30T10:48:06.324Z',
visp-wsrng-server-1  |     startedDate: '2023-11-30T10:38:38.892Z'
visp-wsrng-server-1  |   },
visp-wsrng-server-1  |   patchData: { status: 'COMPLETED', completedDate: '2023-11-30T10:49:36.295Z' }
visp-wsrng-server-1  | }
        */
        
        //This is not working properly, the session-manager is not receiving the request

        let postData = {
            projectId: data.projectName,
            sessionId: data.session.sessionId
        };

        //urlencode data
        let formBody = [];
        for (let property in postData) {
            let encodedKey = encodeURIComponent(property);
            let encodedValue = encodeURIComponent(postData[property]);
            formBody.push(encodedKey + "=" + encodedValue);
        }
        formBody = formBody.join("&");

        axios.post("http://session-manager:8080/api/importaudiofiles", formBody).then(response => {
            console.log(response.status, response.statusText, response.data);
        }).catch(error => {
            console.log(error.code, error.request.data);
        });

    }

    sessionFileUpload(data) {
        this.app.addLog("Session file upload (unimplemented)", "info");
        /*
        data = {
visp-wsrng-server-1  |   audioBinary: <Buffer 52 49 46 46 28 c0 02 00 57 41 56 45 66 6d 74 20 10 00 00 00 01 00 01 00 80 bb 00 00 00 77 01 00 02 00 10 00 64 61 74 61 00 c0 02 00 00 00 00 00 00 00 ... 181198 more bytes>,
visp-wsrng-server-1  |   itemCode: 'VJzb',
visp-wsrng-server-1  |   fileEnding: 'wav',
visp-wsrng-server-1  |   session: {
visp-wsrng-server-1  |     _id: new ObjectId("65684f3450e7a28270f0c48c"),
visp-wsrng-server-1  |     project: '9j73uDStG08-8eV4_fRdR',
visp-wsrng-server-1  |     sessionId: 'IoboULTJ33CgwXWdZk-C6',
visp-wsrng-server-1  |     script: 'WOcsu5KqttZnQJl3GEuuY',
visp-wsrng-server-1  |     debugMode: false,
visp-wsrng-server-1  |     type: 'NORM',
visp-wsrng-server-1  |     status: 'STARTED',
visp-wsrng-server-1  |     sealed: false,
visp-wsrng-server-1  |     loadedDate: '2023-11-30T09:00:36.530Z',
visp-wsrng-server-1  |     restartedDate: '2023-11-30T10:38:27.028Z',
visp-wsrng-server-1  |     startedDate: '2023-11-30T10:38:38.892Z'
visp-wsrng-server-1  |   },
visp-wsrng-server-1  |   filePath: '/repositories/9j73uDStG08-8eV4_fRdR/IoboULTJ33CgwXWdZk-C6/VJzb'
visp-wsrng-server-1  | }
        */

        // repositories/testuser_at_example_dot_com/test_7/Data/VISP_emuDB/sdfsdfsdfsdfd_ses/

        /*
        data = {
            audioBinary: audioBinary,
            itemCode: itemCode,
            fileEnding: fileEnding,
            session: session,
            filePath: filePath
        }
        */

        let projectId = data.session.project;

        //move the file from filePath to the repositories
        let destinationPath = "repositories/"+data.session.project+"/Data/speech_recorder_uploads/emudb-sessions/"+data.session.sessionId+"/"+data.itemCode+"."+data.fileEnding;

        //console.log(destinationPath);
        /*
        try {
            fs.renameSync(data.filePath, destinationPath);
            console.log('File moved successfully!');
        } catch (err) {
            console.error('Error moving file:', err);
        }
        */

        //now import the file into the emuDB
        
    }

    sessionFileUploadOLD(data) {
        console.log("sessionFileUpload");
        //make a post request to gitlab to upload the file
        let commitActions = [];
        let commitData = {
            "branch": "master",
            "commit_message": "recfile from webspeechrecorder",
            "actions": commitActions
        }

        let actionType = "create";
        commitActions.push({
            "action": actionType,
            "file_path": "Data/unimported_audio/emudb-sessions/"+data.session.sessionId+"/"+data.itemCode+"."+data.fileEnding,
            "content": data.audioBinary.toString("base64"),
            "encoding": "base64"
        });

        let requestUrl = "http://gitlab/api/v4/projects/"+data.session.project+"/repository/commits";
        let postData = commitData;
        
        let headers = {
            'Content-Type': 'application/json',
            'PRIVATE-TOKEN': process.env.GIT_API_ACCESS_TOKEN
        };
        
        //this.gitlabCommit(data);
    }

    async gitlabCommit(data, actionType = "create") {
        let commitActions = [];
        let commitData = {
            "branch": "master",
            "commit_message": "recfile from webspeechrecorder",
            "actions": commitActions
        }

        commitActions.push({
            "action": actionType,
            "file_path": "Data/unimported_audio/emudb-sessions/"+data.session.sessionId+"/"+data.itemCode+"."+data.fileEnding,
            "content": data.audioBinary.toString("base64"),
            "encoding": "base64"
        });
        let requestUrl = "http://gitlab/api/v4/projects/"+data.session.project+"/repository/commits";
        let postData = commitData;
        let headers = {
            'Content-Type': 'application/json',
            'PRIVATE-TOKEN': process.env.GIT_API_ACCESS_TOKEN
        };
        try {
            this.app.addLog("Trying to create file in Gitlab", "info");
            let res = await axios.post(requestUrl, postData, { headers: headers });
            if(res.status == 201) {
                //all is well
            }
        }
        catch(error) {
            if(error.response.status == 400) {
                //try again but do an update this time
                this.app.addLog("File already exists, trying to update", "info");
                await this.gitlabCommit(data, "update");
            }
            else {
                this.app.addLog("Gitlab commit error: "+JSON.stringify(error, null, 2), "error");
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