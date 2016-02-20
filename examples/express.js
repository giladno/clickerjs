var path = require('path');
var express = require('express');
var http = require('http');
var io = require('socket.io');
var clicker = require('../clicker.js');
var app = express();
var server = http.Server(app);

app.get('/', function(req, res){
    res.send('<h1>express example</h1><p>open the <a href="/admin">editor</a>');
});

app.use('/admin', clicker.middleware({
    path: path.join(__dirname, 'sample'),
    io: io(server),
}));

server.listen(8095, function(){
    console.log('listening on', this.address().port);
}).on('error', function(err){
    console.error(err);
});
