/**
 * This is the handler module which provides the neccessary functionality for the visp system.
 * It provides GitLab integration by pushing all the recorded/uploaded audio directly to GitLab.
 * As well as notifies the visp backend of the session completion.
 */

import axios from "axios";

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
            console.log(response);
        });
    }

    sessionFileUpload(data) {
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
        
        this.gitlabCommit(data);
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