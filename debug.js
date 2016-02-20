var events = require('events');
var util = require('util');
var net = require('net');
var path = require('path');
var exec = require('./exec.js');
var Protocol = require('_debugger').Protocol;
var PORT = 61016;

function Debug(){
    events.call(this);
    this._seq = 0;
    this._requests = {};
}
util.inherits(Debug, events);
Debug.instances = {};
Debug.prototype.start = function(filename, opts){
    var _this = this;
    this.filename = filename;
    return new Promise(function(resolve, reject){
        opts = opts||{};
        opts.cwd = opts.cwd||path.dirname(filename);
        var child = exec('node', ['--debug-brk='+PORT, filename], opts);
        var timer = setTimeout(function(){
            reject(new Error('Timeout while waiting for the child process to initialize the debugger.'));
        }, 3000);
        child.on('stderr', function(data){
            if (/^[Dd]ebugger listening on port \d+$/m.test(data))
            {
                clearTimeout(timer);
                child.removeAllListeners('stderr');
                _this._child = child;
                Debug.instances[child.pid] = _this;
                setTimeout(resolve, 200);
            }
        }).on('close', function(){
            delete _this.child;
            delete Debug.instances[child.pid];
        });
    });
};
Debug.prototype.stop = function(){
    if (!this._child)
        return;
    this._child.kill();
};
Debug.prototype.connect = function(){
    var _this = this;
    return new Promise(function(resolve, reject){
        var protocol = new Protocol();
        protocol.onResponse = function(res){
            res = res.body;
            if (!res.type)
                return resolve();
            var req = _this._requests[res.request_seq];
            if (req)
            {
                delete _this._requests[res.request_seq];
                if (req.cb)
                    req.cb.call(_this, res, req);
                else
                    _this.emit('response', res, req);
            }
            else if (res.type=='event')
                _this.emit('event', res);
        };
        _this._socket = net.connect(PORT);
        _this._socket.on('data', protocol.execute.bind(protocol));
        _this._socket.on('end', function(){ _this.stop(); });
        _this._socket.on('error', reject);
    });
};
Debug.prototype.request = function(cmd, args){
    var _this = this;
    return new Promise(function(resolve, reject){
        var req = {seq: ++_this._seq, type: 'request', command: cmd, arguments: args};
        var body = JSON.stringify(req);
        _this._socket.write('Content-Length:'+body.length+'\r\n\r\n'+body);
        req.cb = function(res){
            res.success ? resolve(res) : reject(res); };
        _this._requests[req.seq] = req;
    });
};
module.exports = Debug;
process.on('exit', function(){
    for (var pid in Debug.instances)
        Debug.instances[pid].stop();
});
