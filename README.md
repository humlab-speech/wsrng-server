# Humlab/VISP Web Speech Recorder Ng Server
Server for the WebSpeechRecorderNg angular module, found at https://github.com/IPS-LMU/WebSpeechRecorderNg

This server is writen in JavaScript and uses a MongoDB as a backend. It also needs a file area on the server to upload wav files to.

# Installation

## Prerequisites
1. Make sure you have a recent version of NodeJS and NPM. This has been tested on NodeJS v16, may or may not work on previous versions.

1. `git clone https://github.com/humlab-speech/wsrng-server`
1. `cd wsrng-server`
1. `npm install`
1. Copy the file .env-example to .env
1. Edit .env and enter your MongoDB info. Also check that the other settings are to your liking.
1. Setup your application so that all the WebSpeechRecorderNg API calls are routed to this server's address and port. Exactly how to do this depends on what the rest of your infrastructure looks like.

    For example, we are running our WSRNG-client on the web-path /spr and have it setup to route the API calls (all calls made to `/spr/api/v1/*`) to our WSRNG-server via an Apache Location directive like this:

    ```
    <Location /spr/api/v1>
        RequestHeader set X-Forwarded-Proto https
        ProxyPreserveHost On
        ProxyPass         http://wsrng-server:8080
        ProxyPassReverse  http://wsrng-server:8080
    </Location>
    ```
    Here 'wsrng-server' is the hostname of our server since it is run within the same docker cluster.

1. Run `npm start` or `node src/main.js`

# Handler modules

You can write modules which can extend the functionality of this server. There is such a module for the VISP system (in `src/handler_modules/visp.js`) which provides GitLab integration and other things. If you wish to run this server together with the rest of the VISP system you probably want to enable it by adding "visp" to the `ENABLED_MODULES` array in the .env file.