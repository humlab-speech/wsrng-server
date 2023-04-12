class VispHandler {
    constructor() {
        this.name = 'Visp';
    }
    
    handle(eventType, data = null) {
        console.log(eventType, data);

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
        this.addLog("Session is now complete, tell the session-manager to import audio files", "debug");
        axios.post("http://session-manager/importaudiofiles", { projectId: data.projectName, sessionId: data.session.sessionId }).then(response => {
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
            "file_path": "Data/unimported_audio/"+data.session.sessionId+"/"+data.itemCode+"."+data.fileEnding,
            "content": data.audioBinary.toString("base64"),
            "encoding": "base64"
        });

        let requestUrl = "http://gitlab/api/v4/projects/"+data.session.project+"/repository/commits";
        let postData = commitData;
        
        let headers = {
            'Content-Type': 'application/json',
            'PRIVATE-TOKEN': process.env.GIT_API_ACCESS_TOKEN
        };
        
        axios.post(requestUrl, postData, { headers: headers }).then(commitRes => {
            this.addLog("Successfully commited recfile (new) to Gitlab", "info");
            //this.addLog("Gitlab commit success: "+JSON.stringify(commitRes, null, 2), "debug");
        }).catch(error => {
            //this.addLog("Gitlab commit error: "+JSON.stringify(error, null, 2), "error");
            this.addLog("File already exists, trying to update", "debug");
                actionType = "update";
                commitActions[0].action = actionType;
                axios.post(requestUrl, postData, { headers: headers }).then(commitRes => {
                    //this.addLog("Gitlab commit success: "+JSON.stringify(commitRes, null, 2), "debug");
                    this.addLog("Successfully commited recfile (updated) to Gitlab", "info");
                }).catch(error => {
                    this.addLog("Gitlab commit error: "+JSON.stringify(error, null, 2), "error");
                });
        });
    }

    async getPhpSession(request) {
		let cookies = this.parseCookies(request);
        let phpSessionId = cookies.PHPSESSID;

        //this.addLog('Validating phpSessionId '+phpSessionId);

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
                            this.addLog("User not identified");
                            resolve({
                                authenticated: false
                            });
                            return;
                        }
                    }
                    catch(error) {
                        this.addLog("Failed parsing authentication response data", "error");
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