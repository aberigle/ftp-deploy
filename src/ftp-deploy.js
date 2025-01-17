"use strict";

const upath = require("upath");
const util = require("util");
const events = require("events");
const Promise = require("bluebird");
const fs = require("fs");

var PromiseFtp = require("promise-ftp");
var PromiseSftp = require("ssh2-sftp-client");
const lib = require("./lib");

/* interim structure
{
    '/': ['test-inside-root.txt'],
    'folderA': ['test-inside-a.txt'],
    'folderA/folderB': ['test-inside-b.txt'],
    'folderA/folderB/emptyC': [],
    'folderA/folderB/emptyC/folderD': ['test-inside-d-1.txt', 'test-inside-d-2.txt']
}
*/

const FtpDeployer = function () {
    // The constructor for the super class.
    events.EventEmitter.call(this);
    this.ftp = null;
    this.eventObject = {
        totalFilesCount: 0,
        transferredFileCount: 0
    };

    this.makeAllAndUpload = function (config, filemap) {

        let folders = Object.keys(filemap)
        .map(key => {
          return upath.join(config.remoteRoot, key)
        });

        let files   = Object.keys(filemap)
        .map(key => {
          return filemap[key].map(file => {
            if (key === "/") return file
            return upath.join(key, file)
          })
        })
        .flat();

        // create all the dirs
        return Promise.mapSeries(folders, folder => {
          return this.makeDir(folder)
        })
        .then(() => this.makeAndUpload(config, "/", files))
    };

    this.makeDir = function (newDirectory) {
        if (newDirectory === "/") {
            return Promise.resolve("unused");
        } else {
            return this.ftp.mkdir(newDirectory, true);
        }
    };
    // Creates a remote directory and uploads all of the files in it
    // Resolves a confirmation message on success
    this.makeAndUpload = (config, relDir, fnames) => {
        let newDirectory = upath.join(config.remoteRoot, relDir);
        return this.makeDir(newDirectory).then(() => {
            // console.log("newDirectory", newDirectory);

            // get the configured parallelUpload param, default to 1
            const parallelUploads = config.parallelUploads || 1

            // split file list into chunks of configured size
            const chunks = fnames.reduce((result, current, index) => {
              const position   = Math.floor(index / parallelUploads)
              result[position] = [].concat(result[position] || [], current)
              return result
            }, [])

            // iterate every chunk in serie
            return Promise.mapSeries(chunks, chunk =>
              // iterate every element of the chunk in parallel
              Promise.map(chunk, (fname) => {
                let tmpFileName = upath.join(config.localRoot, relDir, fname);
                let tmp = fs.readFileSync(tmpFileName);
                const filename = upath.join(relDir, fname);

                this.emit("uploading", Object.assign({ filename }, this.eventObject));

                return this.ftp
                    .put(tmp, upath.join(config.remoteRoot, relDir, fname))
                    .then(() => {
                        this.eventObject.transferredFileCount++;
                        this.emit("uploaded", Object.assign({ filename }, this.eventObject));
                        return Promise.resolve("uploaded " + tmpFileName);
                    })
                    .catch((err) => {
                        let error = err;
                        this.emit("upload-error", Object.assign({ filename, error }, this.eventObject));
                        // if continue on error....
                        return Promise.reject(err);
                    });
              })
            )
            // flatten the result to return only a list of files
            .then(result => result.flat());
        });
    };

    // connects to the server, Resolves the config on success
    this.connect = (config) => {
        this.ftp = config.sftp ? new PromiseSftp() : new PromiseFtp();

        // sftp client does not provide a connection status
        // so instead provide one ourselfs
        if (config.sftp) {
            this.connectionStatus = "disconnected";
            this.ftp.on("end", this.handleDisconnect);
            this.ftp.on("close", this.handleDisconnect);
        }

        return this.ftp
            .connect(config)
            .then((serverMessage) => {
                this.emit("log", "Connected to: " + config.host);
                this.emit("log", "Connected: Server message: " + serverMessage);

                // sftp does not provide a connection status
                // so instead provide one ourself
                if (config.sftp) {
                    this.connectionStatus = "connected";
                }

                return config;
            })
            .catch((err) => {
                return Promise.reject({
                    code: err.code,
                    message: "connect: " + err.message,
                });
            });
    };

    this.getConnectionStatus = () => {
        // only ftp client provides connection status
        // sftp client connection status is handled using events
        return typeof this.ftp.getConnectionStatus === "function"
            ? this.ftp.getConnectionStatus()
            : this.connectionStatus;
    };

    this.handleDisconnect = () => {
        this.connectionStatus = "disconnected";
    };

    // creates list of all files to upload and starts upload process
    this.checkLocalAndUpload = (config) => {
        try {
            let filemap = lib.parseLocal(
                config.include,
                config.exclude,
                config.localRoot,
                "/"
            );
            // console.log(filemap);
            this.emit(
                "log",
                "Files found to upload: " + JSON.stringify(filemap)
            );
            this.eventObject["totalFilesCount"] = lib.countFiles(filemap);

            return this.makeAllAndUpload(config, filemap);
        } catch (e) {
            return Promise.reject(e);
        }
    };

    // Deletes remote directory if requested by config
    // Returns config
    this.deleteRemote = (config) => {
        if (config.deleteRemote) {
            return lib
                .deleteDir(this.ftp, config.remoteRoot)
                .then(() => {
                    this.emit("log", "Deleted directory: " + config.remoteRoot);
                    return config;
                })
                .catch((err) => {
                    this.emit(
                        "log",
                        "Deleting failed, trying to continue: " +
                            JSON.stringify(err)
                    );
                    return Promise.resolve(config);
                });
        }
        return Promise.resolve(config);
    };

    this.deploy = function (config, cb) {
        return lib
            .checkIncludes(config)
            .then(lib.getPassword)
            .then(this.connect)
            .then(this.deleteRemote)
            .then(this.checkLocalAndUpload)
            .then((res) => {
                this.ftp.end();
                if (typeof cb == "function") {
                    cb(null, res);
                } else {
                    return Promise.resolve(res);
                }
            })
            .catch((err) => {
                console.log("Err", err.message);
                if (this.ftp && this.getConnectionStatus() != "disconnected")
                    this.ftp.end();
                if (typeof cb == "function") {
                    cb(err, null);
                } else {
                    return Promise.reject(err);
                }
            });
    };
};

util.inherits(FtpDeployer, events.EventEmitter);

module.exports = FtpDeployer;
