var child_process = require('child_process');
module.exports = function(){
    var child = child_process.spawn.apply(child_process, [].slice.call(arguments));
    var clear = {stdout: true, stderr: true};
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function(output){
        child.emit('stdout', output, clear.stdout);
        delete clear.stdout;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function(output){
        child.emit('stderr', output, clear.stderr);
        delete clear.stderr;
    });
    return child;
};
