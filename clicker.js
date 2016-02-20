#!/usr/bin/env node
var _ = require('underscore');
var path = require('path');
var fs = require('fs-extra');
var pm2 = require('pm2');
var express = require('express');
var exec = require('./exec.js');
var util = require('util');
var term = require('term.js');
var pty = require('pty.js');
var http = require('http');
var vm = require('vm');
var Debug = require('./debug.js');
module.exports = {};
module.exports.middleware = function(config){
    _.defaults(config, {
        path: process.cwd(),
        run: function(filename){
            if (path.basename(filename)=='bower.json')
                return ['bower', '--loglevel', 'info', 'install'];
            if (path.basename(filename)=='package.json')
                return ['npm', '--loglevel', 'info', 'install'];
        },
        namespace: 'a538fe2f-4ea6-471b-987d-e43b957d4b63',
        terminal: '\\[\\033[36m\\]\\u\\[\\033[m\\]@\\[\\033[32m\\]\\h:\\[\\033'+
            '[33;1m\\]\\w\\[\\033[m\\]\$ ',
    });
    var app = express();
    var io = config.io.of('/'+config.namespace);
    app.get('/files', function(req, res, next){
        var parent = req.query.parent||'';
        var dir = path.join(config.path, parent||'./');
        fs.readdir(dir, function(err, files){
            if (err)
                return next(err);
            res.json(files.reduce(function(data, filename){
                var ar = fs.lstatSync(path.join(dir, filename)).isDirectory() ?
                    data.dirs : data.files;
                ar.push({id: path.join(parent, filename), text: filename});
                return data;
            }, {files: [], dirs: []}));
        });
    });
    app.get('/download/:path(*)', function(req, res){
        res.sendFile(path.join(config.path, req.params.path)); });
    io.on('connection', function(socket){
        var debug = Object.keys(Debug.instances).reduce(function(debug, pid){
            return debug||Debug.instances[pid];
        }, null);
        var terminal = pty.spawn('bash', [], {
            name: 'xterm-color',
            cwd: config.path,
            env: _.extend({PS1: config.terminal}, process.env),
        });
        var context = vm.createContext();
        terminal.on('data', function(data){ socket.emit('terminal', data); });
        socket.on('disconnect', function(){
            terminal.destroy();
        }).on('upload', function(data){
            fs.writeFile(path.join(config.path, data.filename), data.data, function(err){
                if (err)
                    console.error(err);
            });
        }).on('delete', function(data){
            var filename = path.join(config.path, data.filename);
            if (fs.lstatSync(filename).isDirectory())
            {
                fs.rmdir(filename, function(err){
                    if (err)
                        console.error(err);
                });
            }
            else
                fs.unlink(filename, function(err){
                    if (err)
                        console.error(err);
                });
        }).on('rename', function(data){
            var filename = path.join(config.path, data.filename);
            fs.rename(filename, path.join(path.dirname(filename), data.name), function(err){
                if (err)
                    console.error(err);
            });
        }).on('touch', function(data){
            if (!data.filename)
                return;
            var filename = path.join(config.path, data.parent||'', data.filename);
            fs.ensureFile(filename, function(err){
                if (err)
                    console.error(err);
            });
        }).on('debug', function(data){
            data = data||{};
            if (data.evaluate)
            {
                if (debug)
                {
                    return debug.request('evaluate', {
                        expression: data.evaluate,
                        frame: (+data.frame)||0,
                    }).then(function(res){
                        socket.emit('debug', _.extend(data,
                            {response: res.body.text}));
                    });
                }
                var res;
                try {
                    res = vm.runInContext(data.evaluate, context);
                }
                catch(e){
                    res = e.toString();
                }
                return socket.emit('debug', _.extend(data, {response: util.inspect(res)}));
            }
            if (!debug)
                return socket.emit('debug', {});
            if (data.continue)
            {
                delete debug.break;
                return debug.request('continue', data.stepaction && {stepaction: data.stepaction});
            }
            if (data.stop)
            {
                debug.stop();
                debug = null;
                return io.emit('debug', {});
            }
            if (data.breakpoints)
            {
                return Promise.all(data.breakpoints.map(function(data){
                    if (data.clear)
                    {
                        return debug.request('clearbreakpoint', {
                            breakpoint: data.breakpoint,
                        }).then(function(res){
                            debug.breakpoints = debug.breakpoints.filter(function(bp){
                                return bp.breakpoint!=data.breakpoint; });
                        });
                    }
                    if (data.filename)
                    {
                        return debug.request('setbreakpoint', {
                            type: 'script',
                            target: path.join(config.path, data.filename),
                            line: data.line,
                        }).then(function(res){
                            debug.breakpoints.push({
                                filename: data.filename,
                                line: +data.line,
                                breakpoint: res.body.breakpoint,
                            });
                        });
                    }
                    return Promise.resolve();
                })).then(function(){
                    io.emit('debug', {breakpoints: debug.breakpoints,
                        break: debug.break});
                });
                socket.emit('debug', {
                    breakpoints: debug.breakpoints,
                    break: debug.break,
                });
            }
        }).on('pm2', function(data){
            if (!data.filename)
                return;
            var filename = path.join(config.path, data.filename);
            if (path.extname(filename)!='.js')
            {
                if (!data.run)
                    return socket.emit('pm2', {filename: data.filename});
                var cmd = config.run(filename);
                if (!cmd)
                    return;
                var child = exec(cmd[0], cmd.slice(1),
                    {cwd: config.path});
                child.on('stdout', function(data, clear){
                    socket.emit('pm2', {filename: data.filename, stdout: data,
                        clear: clear});
                });
                child.on('stderr', function(data, clear){
                    socket.emit('pm2', {filename: data.filename, stderr: data,
                        clear: clear});
                });
                child.on('close', function(code, signal){ });
                child.on('error', function(err){ console.error(err); });
                return;
            }
            if (debug && debug.filename==filename)
            {
                if (data.run)
                {
                    delete debug.break;
                    debug.request('continue', _.pick(data, 'stepaction'));
                }
                else if (data.stop)
                {
                    debug.stop();
                    debug = null;
                    io.emit('debug', {filename: data.filename});
                    return socket.emit('pm2', {filename: data.filename});
                }
                return socket.emit('pm2', {filename: data.filename, debug: true});
            }
            pm2.list(function(err, list){
                if (err)
                    return console.error(err);
                var running = list.some(function(p){
                    return p.pm2_env.pm_exec_path==filename; });
                if (data.run)
                {
                    pm2[running ? 'restart' : 'start'].call(pm2, filename, function(err, p){
                        if (err)
                            return console.error(err);
                        socket.emit('pm2', {filename: data.filename, running: true});
                    });
                }
                else if (data.stop)
                {
                    if (running)
                    {
                        pm2.delete(filename, function(err, p){
                            if (err)
                                return console.error(err);
                            socket.emit('pm2', {filename: data.filename});
                        });
                    }
                }
                else if (data.debug && !running)
                {
                    debug = new Debug();
                    debug.breakpoints = [];
                    debug.on('event', function(res){
                        if (res.event=='afterCompile')
                            return;
                        if (res.event=='break')
                        {
                            debug.request('scripts').then(function(scripts){
                                var scripts = scripts.body.reduce(function(o, s){
                                    if (s.name && s.name.startsWith('/'))
                                        o[s.handle] = s.name;
                                    return o;
                                }, {});
                                debug.request('backtrace').then(function(res){
                                    return Promise.all(res.body.frames.filter(function(f){
                                        return scripts[f.script.ref];
                                    }).map(function(f){
                                        var args = [].concat(f.arguments, f.locals).reduce(function(o, arg){
                                            o[arg.value.ref] = arg.name;
                                            return o;
                                        }, {});
                                        return debug.request('lookup', {handles: Object.keys(args)}).then(function(res){
                                            return {
                                                filename: path.relative(config.path,
                                                    scripts[f.script.ref]),
                                                line: f.line,
                                                frame: f.index,
                                                locals: Object.keys(args).reduce(function(o, id){
                                                    var data = {text: res.body[id].text};
                                                    if (res.body[id].script && scripts[res.body[id].script.ref])
                                                    {
                                                        data.filename = path.relative(config.path,
                                                            scripts[res.body[id].script.ref]);
                                                        data.line = res.body[id].line;
                                                    }
                                                    o[args[id]] = data;
                                                    return o;
                                                }, {}),
                                            };
                                        });
                                    }));
                                }).then(function(res){
                                    debug.break = res;
                                    io.emit('debug', {breakpoints: debug.breakpoints,
                                        break: debug.break});
                                });
                            });
                        }
                    });
                    debug.start(filename, {cwd: __dirname}).then(function(){
                        return debug.connect();
                    }).then(function(){
                        return debug.request('version');
                    }).then(function(){
                        io.emit('pm2', {filename: data.filename, debug: true});
                    }).catch(function(err){
                        console.error(err);
                    });
                }
                else
                    socket.emit('pm2', {filename: data.filename, running: running});
            });
        }).on('terminal', function(data){
            if (typeof data=='string')
                terminal.write(data);
            else if (typeof data=='object')
            {
                if (data.cols && data.rows)
                    terminal.resize(data.cols, data.rows);
            }
        });
        socket.emit('debug', {breakpoints: debug && debug.breakpoints,
            break: debug && debug.break});
    });
    fs.watch(config.path, {persistent: false, recursive: true}, function(event, filename){
        fs.lstat(path.join(config.path, filename), function(err){
            if (err)
                event = 'delete';
            io.emit('watch', {filename: filename, event: event});
        });
    });
    app.use(term.middleware());
    app.use(express.static(path.join(__dirname, 'external')));
    app.get('/', function(req, res, next){
        fs.readFile(path.join(__dirname, 'public/index.html'), {encoding: 'utf8'}, function(err, data){
            if (err)
                return next(err);
            res.send(_.template(data)(config));
        });
    });
    pm2.connect(function(err){
        if (err)
            return console.error(err);
    });
    return app;
};
module.exports.server = function(config){
    return new Promise(function(resolve, reject){
        config = config||{};
        var app = express();
        var server = http.Server(app);
        app.use(module.exports.middleware(_.extend({io: require('socket.io')(server)},
            config)));
        server.listen(config.port||8085, function(){
            resolve(server); }).on('error', reject);
    });
};

module.exports.debug = function(port){
    return new Debug(port);
};
if (!module.parent)
{
    var argv = require('yargs')
        .usage('Usage: $0 [options] <directory>')
        .alias('p', 'port')
        .nargs('p', 1)
        .number('p')
        .default('p', 8085)
        .describe('p', 'Port number')
        .help('h')
        .alias('h', 'help')
        .epilog('copyright 2016 by Gilad Novik')
        .argv;
    module.exports.server({
        path: path.resolve(process.cwd(), argv._[0]||'.'),
        port: argv.port,
    }).then(function(server){
        console.log('server listening on', server.address().port);
    }).catch(function(err){
        console.error(err);
    });
}
