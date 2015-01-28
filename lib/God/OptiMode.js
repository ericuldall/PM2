'use strict';

/**
 * @file Fork execution related functions
 * @author Alexandre Strzelewicz <as@unitech.io>
 * @project PM2
 */

var log           = require('debug')('pm2:god');
var fs            = require('fs');
var cst           = require('../../constants.js');
var moment        = require('moment');
var Common        = require('../Common');
var Utility       = require('../Utility.js');

/**
 * Description
 * @method exports
 * @param {} God
 * @return
 */
module.exports = function OptiMode(God) {
  /**
   * For all apps - FORK MODE
   * fork the app
   * @method optiMode
   * @param {} pm2_env
   * @param {} cb
   * @return
   */
  God.optiMode = function optiMode(pm2_env, cb) {
    var command = '';
    var args    = [];

    console.log('Starting execution sequence in -opti mode- for app name:%s id:%s',
                pm2_env.name,
                pm2_env.pm_id);
    var spawn = require('child_process').spawn;

    var interpreter = pm2_env.exec_interpreter || 'node';
    var pidFile     = pm2_env.pm_pid_path;

    if (interpreter !== 'none') {
      command = interpreter;

      if (pm2_env.node_args && Array.isArray(pm2_env.node_args)) {
        args = args.concat(pm2_env.node_args);
      }

      if (process.env.PM2_NODE_OPTIONS) {
        args = args.concat(process.env.PM2_NODE_OPTIONS.split(' '));
      }

      args.push(pm2_env.pm_exec_path);
    }
    else {
      command = pm2_env.pm_exec_path;
      args = [ ];
    }

    if (pm2_env.args) {
      args = args.concat(pm2_env.args);
    }

    // piping stream o file
    var stds = {
      out: pm2_env.pm_out_log_path,
      err: pm2_env.pm_err_log_path
    };

    // entire log std if necessary.
    if ('pm_log_path' in pm2_env){
      stds.std = pm2_env.pm_log_path;
    }

    Utility.startLogging(stds, function(err, result) {
	// get cpu info, otherwise we can't optimize
	var lscpu = spawn('lscpu | grep \'CPU(s):\'', '', {}).stdout.on('data', function(data){
		// split cpu rows
	      	var cores = data.split(/\n/);
		var cores_json = {};
		// build CPU(s) json
		for(var i=0; i<cores.length; i++){
			core_info = cores[i].split(/:\s+/);
			cores_json[core_info[0]] = core_info[1];
		}
		// get num cores
		var core_count = 0;
		// loop over cpu records
		for(var key in cores_json){
			// check for hard CPU(s)
			if( key == 'CPU(s)' ){
				// set core count
				core_count = cores_json[key];
			}

			// check for virtual CPU(s)
			if( key == 'NUMA node0 CPU(s)' ){
				// determine virtual count
				var core_check = parseInt(cores_json[key].split('-')[1]) + 1;
				// if more virtual cores than hard cores allow compatibility for virtual cores
				if( core_check > core_count ){
					// update core count to v cores
					core_count = core_check;
				}
			}
		}
		// if core count is 0, something went wrong
		if( core_count = 0 ){
			err = 'Failed to identify system core(s)! Cannot optimize, please run in fork mode.';
		}

	      if (err) {
		God.logAndGenerateError(err);
		return cb(err);
	      };

	   // basic fork method with affinity set per pid bound to free core
	   var spawn_to_core = function(core){
	     try {
		var cspr = spawn(command, args, {
		  env      : pm2_env,
		  detached : true,
		  cwd      : pm2_env.pm_cwd || process.cwd(),
		  stdio    : ['pipe', 'pipe', 'pipe', 'ipc'] //Same as fork() in node core
		});
	      } catch(e) {
		God.logAndGenerateError(e);
		if (cb) return cb(e);
	      }

	      cspr.process = {};
	      cspr.process.pid = cspr.pid;
	      cspr.pm2_env = pm2_env;
	      cspr.pm2_env.status = cst.ONLINE_STATUS;

	      // bind process to current core
	      var taskset = spawn('taskset', ['0x0000000'+(core + 1), '-p '+cspr.pid], {});

	      cspr.stderr.on('data', function forkErrData(data) {
		var log_data = data.toString();

		if (pm2_env.log_date_format)
		  log_data = moment().format(pm2_env.log_date_format) + ': ' + log_data;

		stds.err.write && stds.err.write(log_data);
		stds.std && stds.std.write && stds.std.write(log_data);

		God.bus.emit('log:err', {
		  process : Common.formatCLU(cspr),
		  at  : Utility.getDate(),
		  data : {
		    str : data.toString()
		  }
		});
	      });

	      cspr.stdout.on('data', function forkOutData(data) {
		var log_data = data.toString();

		if (pm2_env.log_date_format)
		  log_data = moment().format(pm2_env.log_date_format) + ': ' + log_data;

		stds.out.write && stds.out.write(log_data);
		stds.std && stds.std.write && stds.std.write(log_data);

		God.bus.emit('log:out', {
		  process : Common.formatCLU(cspr),
		  at  : Utility.getDate(),
		  data : {
		    str : data.toString()
		  }
		});
	      });

	      /**
	       * Broadcast message to God
	       */
	      cspr.on('message', function forkMessage(msg) {
		/*********************************
		 * If you edit this function
		 * Do the same in ClusterMode.js !
		 *********************************/
		if (msg.data && msg.type) {
		  return God.bus.emit(msg.type ? msg.type : 'process:msg', {
		    at      : Utility.getDate(),
		    data    : msg.data,
		    process : Common.formatCLU(cspr)
		  });
		}
		else {
		  return God.bus.emit('process:msg', msg);
		}
	      });

	      fs.writeFileSync(pidFile, cspr.pid);

	      cspr.once('close', function forkClose(status) {
		try {
		  for(var k in stds){
		    stds[k].close();
		    stds[k] = stds[k]._file;
		  }
		} catch(e) { God.logAndGenerateError(e);}
	      });

	      cspr._reloadLogs = function(cb) {
		for (var k in stds){
		  stds[k].close();
		  stds[k] = stds[k]._file;
		}
		cspr.removeAllListeners();
		Utility.startLogging(stds, cb);
	      };

	      cspr.unref();

		return cspr;

	   };

		// store node processes
		var csprs = [];

		// loop over cores
	    	for(var i=0; i<core_count; i++){
			// push node process to core
	     		csprs.push(spawn_to_core(i));
		}

		// return process array or false
	      	if (cb) return cb(null, csprs);
	      	return false;
	});
    });

  };
};
