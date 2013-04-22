var http = require('http');

var config = {
    n: 0,
    concurrency: 100,
    host: '127.0.0.1',
    port: 8888,
    path: '/',
    controlPort: 8889,
};

var stats = {
    clients: 0,
    inproc: 0,
    errors_req: 0,
    errors_resp: 0,
    ended_req: 0,
};

var clients = {};

function makeRequest() {
    stats.inproc++;
    var id = Math.random().toString(36).slice(2);
    var req = http.request({host:config.host, port:config.port, path:config.path, agent:false});
    req.setNoDelay();

    req.on('response', function(res) {
        stats.inproc--;
        stats.clients++;
        clients[id] = req;
        //res.setEncoding('utf8');
        //res.on('data', function (chunk) {
        //  console.log('BODY: ' + chunk);
        //});

        res.on('end', function() {
            if (clients[id]) {
                stats.clients--;
                delete clients[id];
            }
            stats.ended_req++;
        });
        res.on('error', function() {
            if (clients[id]) {
                stats.clients--;
                delete clients[id];
            }
            stats.errors_resp++;
        });
    });
    req.on('error', function() {
        stats.inproc--;
        stats.errors_req++;
    });

    req.end();
}

// Controlling loop.
setInterval(function() {
    // Make connections if needed.
    while (config.n > stats.clients + stats.inproc && stats.inproc < config.concurrency)
        makeRequest();

    // Abort connections if needed.
    if (config.n < stats.clients) {
        var keys = Object.keys(clients).slice(0, stats.clients-config.n);
        for (var i = 0; i < keys.length; i++) {
            clients[keys[i]].abort();
            stats.clients--;
            delete clients[keys[i]];
        }
    }
}, 100);

// Output stats to console for debugging.
// With upstart job, it ends up in /var/log/upstart/client.log.
console.log("==== Client Started ===== Time: "+new Date().toISOString())
setInterval(function() {
    console.log(JSON.stringify(stats));
}, 1000);

// Controlling server.
http.createServer(function (req, res) {
    if (req.method === "GET") {
        var url = require('url').parse(req.url, true);

        if (url.pathname === '/') {
            // Return stats on '/'
            return res.end(JSON.stringify(stats) + "\n");

        } else if (url.pathname === '/set') {
            // Set params on '/set', preserving the type of param.
            for (var key in url.query)
                config[key] = (typeof config[key] == 'number') ? +url.query[key] : url.query[key];
            return res.end(JSON.stringify(config) + "\n");
        
        } else if (url.pathname === '/restart') {
            // Restart process on '/restart'
            require('child_process').exec("sudo restart client", function() {});
            return res.end("OK\n");
        }
    }
    res.writeHead(404);
    res.end();
}).listen(config.controlPort);
