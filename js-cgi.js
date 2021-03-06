/*******************************************
* js-cgi.js
* Copyright (c) 2015, Darrel Kathan 
* Licensed under the MIT license.
*
* A current version and some documentation is available at
*    https://github.com/kathan/js-cgi
*
* @summary     Javascript CGI process manager
* @description js-cgi is a javascript CGI process manager, similar to php-fpm, for executing node.js compatible scripts behind NGINX or Apache.
* @file        js-cgi.js
* @version     1.1.1
* @author      Darrel Kathan
* @license     MIT
* 2/16/16 - Added cluster node cache
* 7/6/16 - Added script timeout override
* 2/16/17 - Added middleware option
* 4/13/17 - Major timeout bug fix 
* 11/3/17 - Added cgi function
* 11/29/17 - Added path_info
*******************************************/
"use strict";
process.title = 'js-cgi';
var cluster = require("cluster"),
  _ = require("lodash"),
  url = require("url"),
  fs = require("fs"),
  vm = require("vm"),
  os = require("os"),
  util = require("util"),
  path = require("path"),
  express = require("express"),
  app = express(),
  config_name = "js-cgi.config",
  use_name = "use.js",
  config = {};
/******************************************
* Capture console.log and console.error 
* input to log file.
*******************************************/
var console_log = console.log,
  console_error = console.error;

console.log = function() {
  var d = new Date(),
    log_msg = d.toString() + " - (" + process.pid + "): ";
  if (config.output_log) {
    fs.appendFile(
      config.output_log,
      log_msg + util.format.apply(this, arguments) + "\n",
      function() {
        return;
      }
    );
  }
  return console_log.apply(this, arguments);
};

console.error = function(err) {
  var d = new Date(),
    log_msg = d.toString() + " - (" + process.pid + "): ";

  if (config.error_log) {
    fs.appendFile(
      config.error_log,
      log_msg + util.format.apply(this, arguments) + "\n",
      function() {
        return;
      }
    );
    if (err && err.stack) {
      fs.appendFile(
        config.error_log,
        err.stack + util.format.apply(this, arguments) + "\n",
        function() {
          return;
        }
      );
    }
  }
  return console_error.apply(this, arguments);
};

/*******************************************
* Prepare web server to handle cookies and
* format JSON.
*******************************************/

app.set("json spaces", 2);

//console.log(config.output_log);
if (fs.existsSync(path.join(__dirname, config_name))) {
  //Load the congfig file
  console.log("Loading " + config_name + "...");
  config = require("./" + config_name);
}

if (fs.existsSync(path.join(__dirname, use_name))) {
  //Load the congfig file
  console.log("Loading " + use_name + "...");
  var mid_ware = require("./" + use_name);
  if (typeof mid_ware === "function") {
    mid_ware(app);
  } else {
    console.error("Use file is malformed.");
  }
}

//Set default config items
!config.output_log
  ? (config.output_log = path.dirname(process.argv[1]) + "/js-cgi.log")
  : "";
!config.error_log
  ? (config.error_log = path.dirname(process.argv[1]) + "/err.log")
  : "";
!config.port ? (config.port = 3000) : "";
!config.localhostOnly ? (config.localhostOnly = true) : "";
!config.timeout ? (config.timeout = 30000) : "";
!config.workers ? (config.workers = os.cpus().length - 1) : ""; //Subtract one for the master
!config.watch_required ? (config.watch_required = false) : "";

/*******************************************
* Override the "require" function to watch
* if required files have change and expire
* them from cache when they do.
*******************************************/
var assert = require("assert").ok,
  Module = require("module");
if (typeof Module._watching !== "object") {
  Module._watching = {};
}
function watchRequired(fn) {
  /*var fs = require('fs')
    console = console;*/
  //console.log(fn);
  if (Module._watching && !Module._watching.hasOwnProperty(fn)) {
    if (fs.existsSync(fn) && !Module._watching.hasOwnProperty(fn)) {
      console.log("Watching " + fn);
      Module._watching[fn] = fs.watch(fn, (event, f) => {
        //Module._watching[fn] = fs.watchFile(fn, function(curr, prev){
        console.log(fn, event);

        if (Module._cache.hasOwnProperty(fn)) {
          console.log("Expiring " + fn);
          //fs.unwatch(fn, function(){return;});
          return delete Module._cache[fn];
        }
        return;
      });
    }
  }
}

Module.prototype.require = function(path) {
  assert(path, "missing path");
  assert(typeof path === "string", "path must be a string");
  if (config.watch_required) {
    watchRequired(Module._resolveFilename(path, this));
  }
  return Module._load(path, this);
};

/*******************************************
* Start up the server node.
*******************************************/
if (cluster.isMaster) {
  cluster.globals = {};
  cluster.fork().on("error", console.error); //At least one worker is required.
  console.log(process.versions);
  for (var w = 2; w <= config.workers; w++) {
    cluster.fork().on("error", console.error);
  }

  cluster.on("disconnect", worker => {
    cluster.fork().on("error", console.error);
  });

  cluster.on("listening", (worker, address) => {
    console.log("A worker is now connected to " + JSON.stringify(address));
  });
} else {
  // the worker
  var domain = require("domain"),
    server,
    d = domain.create();

  d.on("error", err => {
    console.error("Domain Error:", err, err.stack);
    //console.trace();
    try {
      // make sure we close down if it times out
      //var killtimer = setTimeout(() => {
      //var err = new Error('Killing process.');

      //console.error('Domain Error:', err);
      //console.trace();
      console.log("Killing process.");
      process.exit(1);
      //}, config.timeout);

      // But don't keep the process open just for that!
      //killtimer.unref();

      // stop taking new requests.
      server.close();

      // Let the master know we're dead.  This will trigger a
      // 'disconnect' in the cluster master, and then it will fork
      // a new worker.
      cluster.worker.disconnect();
    } catch (er2) {
      // oh well, not much we can do at this point.
      console.error(er2);
    }
  });

  /*******************************************
    * Now run the handler function in the domain.
    *******************************************/
  d.run(() => {
    console.log("Listening on " + config.port);

    server = app.listen(config.port);

    app.all("*", (req, res) => {
      //console.log('req');
      return handleRequest(req, res);
    });
  });
}

/*******************************************
* This is where all of the web requests are
* handled.
*******************************************/
function handleRequest(req, res) {
  //console.log('request:', req);
  var url_obj = url.parse(req.url, true),
      file_path;
  console.log(req.headers);
  /*var cache = [],
    j = JSON.stringify(req, function(key, value) {
      
      if (typeof value === 'object' && value !== null) {
        var idx = _.findIndex(cache, value);
        if (idx > -1) {return '[Circular '+idx+']';}
        cache.push(value);
      }
    return value;
  });
  
  res.send(j);*/
  //console.log('req.connection.remoteFamily:', '"'+req.connection.remoteFamily+'"');
  //console.log('req.connection.remoteAddress:', '"'+req.connection.remoteAddress+'"');
  if (config.localhostOnly) {
    if (
      (req.connection.remoteFamily === "IPv4" &&
        req.connection.remoteAddress !== "127.0.0.1") ||
      (req.connection.remoteFamily === "IPv6" &&
        (!_.endsWith(req.connection.remoteAddress, "::1") &&
          !_.endsWith(req.connection.remoteAddress, ":127.0.0.1")))
    ) {
      return res.sendStatus(401);
    }
  }

  //Set to the directory path
  if (!req.headers.path_translated) {
    req.headers.path_translated = __dirname + "/www";
    //console.log(req.headers.path_translated);
    if (!fs.existsSync(req.headers.path_translated)) {
      fs.mkdirSync(req.headers.path_translated);
    }
  }

  //
  if(req.headers.path_translated && req.headers.script_name)
    file_path = req.headers.path_translated + req.headers.script_name;
  else if (req.headers.path_translated && url_obj.pathname) {
    file_path = req.headers.path_translated + url_obj.pathname;
  } else {
    file_path = url_obj.pathname;
  }
  console.log(req.method + ": " + file_path);
  function resolveModule(module) {
    if (module.charAt(0) !== ".") {
      return module;
    }
    return path.resolve(path.dirname(file_path), module);
  }

  //If the requested file exists...
  fs.exists(file_path, exists => {
    if (exists) {
      fs.readFile(file_path, (err, source) => {
        if (err) {
          //Error reading file
          console.error(err);
          return res
            .status(500)
            .send({ error: err.toString(), stack: err.stack });
        }
        try {
          //console.log(require.cache);
          //var timer = 'not set';
          req.timeout = config.timeout;
          var timer,
              sandbox = {
                console: console,
                setImmediate: setImmediate,
                setInterval: setInterval,
                setTimeout: setTimeout,
                clearTimeout: clearTimeout,
                Buffer: Buffer,
                JSON: JSON,
                require: function(name) {
                  var mod_path = resolveModule(name);
                  //watchRequired(mod_path);
                  return require(mod_path);
                },
                req: req,
                res: res,
                process: process,
                __dirname: path.dirname(file_path),
                __filename: path.basename(file_path)
              },
              setKilltimer = function() {
                //!req.timeout ? (req.timeout = config.timeout) : "";
                var to_start = Date.now();
                var timeout = req.timeout;
                if (timeout > 0) {
                  return setTimeout(() => {
                    var to_end = Date.now(),
                        msg =
                          "Timeout expired (" +
                          (to_end - to_start) +
                          " ms) for " +
                          file_path,
                        err;
  
                    //if(!res.headerSent){
                    res.status(408).send(msg);
                    //}
                    //err = new Error(msg);
                    console.error(msg);
                    return;
                  }, req.timeout);
                }
              };
          /****************************
          * Capture "res.send" and 
          * "res.sendFile" calls to
          * be able to unset timeout
          * when the script ends. */
          var send = res.send;
          res.send = function(){
            if(timer){
              console.log('timeout cleared');
              clearTimeout(timer);
            }
            return send.apply(this, arguments);
          };
          var sendFile = res.sendFile;
          res.sendFile = function(){
            if(timer){
              console.log('timeout cleared');
              clearTimeout(timer);
            }
            return sendFile.apply(this, arguments);
          }
          /***************************/

          /*****************
           * Start VM Code *
           *****************/
          var c = vm.createContext(sandbox),
              code = `function runInContext() {try{${source}                          //0
                          if(typeof cgi === 'function'){                              //1
                            cgi(req, res);                                            //2
                          }                                                           //3
                        }catch(e){                                                    //4
                          console.error(e);                                           //5
                          res.status(500).send({error: e.toString(), stack: e.stack});//6
                        }                                                             //7
                      }                                                               //8
                                                                                      //9
                      runInContext();`;
          /***************
          * End VM Code *
          ***************/

          /***************************************************
           * Set the kill timer after executing the script so 
           * the script can set the timeout duration.
           ***************************************************/
          var result = vm.runInContext(code, c, file_path);
          timer = setKilltimer();
          return result;
        } catch (err) {
          console.error(err);
          return res
            .status(500)
            .send({ error: err.toString(), stack: err.stack });
        }
      });
    } else {
      //File does not exist
      return res.status(404).send("File not found. " + file_path);
    }
  });
}
