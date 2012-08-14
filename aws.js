#!/usr/bin/env node

var fs = require('fs'),
    http = require('http'),
    aws2js = require('aws2js'),
    program = require('commander'),
    async = require('async'),
    config = require('./aws-config.json'),
    command_given = false;

program
    .version('0.1.0');

program
    .command('start [num] [region]')
    .description('Add <num> AWS instances. Default = 1.')
    .action(function(num, region) {
        command_given = true;
        var nInstances = +(num || 1);
        var regions = region ? [region] : config.regions;
        for (var i = 0; i < nInstances; i++)
            startInstance(getClient(regions[i%regions.length])); // Start equally in all regions.
    });

program
    .command('stop [num] [region]')
    .description('Remove <num> AWS instances. Default = 1. Accepts \'all\'.')
    .action(function(num, region) {
        command_given = true;
        var nInstances = (num == "all") ? 10000 : +(num || 1);
        var regions = region ? [region] : config.regions;
        async.map(regions.map(getClient), getInstances, function(err, res) {
            var instanceCount = res.map(function(r){return r.length;}).reduce(function(a,b){return a+b}, 0);
            nInstances = Math.min(nInstances, instanceCount);
            var regionId = -1;
            var instancesToTerminate = regions.map(function() {return [];});
            for (var i = 0; i < nInstances; i++) {
                regionId = (regionId+1) % regions.length;
                while (res[regionId].length === 0) regionId = (regionId+1) % regions.length;
                instancesToTerminate[regionId].push(res[regionId].shift().instanceId);
            }
            for (var i = 0; i < regions.length; i++) {
                stopInstances(getClient(regions[i]), instancesToTerminate[i]);
            }
        });
    });

program
    .command('status [region]')
    .description('Top-like automatically updating status of instances in all regions.')
    .action(function(region) {
        command_given = true;
        var regions = region ? [region] : config.regions;
        updateInstances(regions);
        setInterval(printStatus, 500);
    });

program
    .command('set <param> <value>')
    .description('Set a parameter to given value in all current instances.')
    .action(function(param, val) {
        command_given = true;
        var regions = config.regions;
        regions.map(getClient).forEach(function(client) {
            getInstances(client, function(err, instances) {
                for (var i = 0; i < instances.length; i++) {
                    sendParam(client, instances[i], param, val);
                }
            });
        });
    });

// ====== Working with instances ===============================================
function normalizeResponse(obj, key) { // Handles quirks of xml-to-js transformation ('item', empty objects)
    if (typeof obj == 'object') {
        var keys = Object.keys(obj);
        if (keys.length === 0) {
            if (key && (key.slice(-3) === "Set" || key.slice(-1) === "s")) // Heuristic to determine empty arrays from empty strings.
                return [];
            return "";
        }
        if (keys.length === 1 && keys[0] === 'item') {
            if (!Array.isArray(obj.item)) obj.item = [obj.item];
            return normalizeResponse(obj.item);
        }
        for (var i = 0; i < keys.length; i++)
            obj[keys[i]] = normalizeResponse(obj[keys[i]], keys[i]);
    }
    return obj;
}

var regionInstances = { // We are interested in Ubuntu Server 12.04 LTS (64 bit, EBS)
    "ap-northeast-1": "ami-c641f2c7",
    "ap-southeast-1": "ami-acf6b0fe",
    "eu-west-1": "ami-ab9491df",
    "sa-east-1": "ami-5c03dd41",
    "us-east-1": "ami-82fa58eb",
    "us-west-1": "ami-5965401c",
    "us-west-2": "ami-4438b474",
};

var clients = {}; // {<region>: <ec2 client>}
function getClient(region) {
    region = region || config.regions[0] || "us-east-1";
    if (!clients[region]) {
        var client = clients[region] = aws2js.load('ec2');
        client.region = region;

        if (!(region in regionInstances))
            throw new Error("Unknown AWS region: "+region+". Must be one of: "+Object.keys(regionInstances));
        client.setRegion(region);

        if (typeof config.accessKeyId !== 'string' || config.accessKeyId.length !== 20 ||
            typeof config.accessKeySecret != 'string' || config.accessKeySecret.length !== 40)
            throw new Error("Please provide AWS Access Keys in 'aws-config.json' file.")
        client.setCredentials(config.accessKeyId, config.accessKeySecret);
    }
    return clients[region];
}


function startInstance(client) {
    // Prepare userdata and do a basic templating (replace <%=filename.ext%> to contents of filename.ext).
    var userdata = fs.readFileSync(config.userDataFile, "utf8").replace(/<%=(.*)%>/g, function(_, name) {
        return fs.readFileSync(name, "utf8");
    });

    // We use Cloud Init, see https://help.ubuntu.com/community/CloudInit
    var params = {
        InstanceType: (config.instanceType || "t1.micro"),
        ImageId: regionInstances[client.region],
        MinCount: 1,
        MaxCount: 1,
        UserData: new Buffer(userdata).toString("base64"),
    };
    if (config.keyName) {
        // To gain ssh access to instances, you should either upload a key to 
        // all given EC2 regions and use it here, or use Cloud Init to write them manually.
        params.KeyName = config.keyName;
    }

    // http://docs.amazonwebservices.com/AWSEC2/latest/APIReference/ApiReference-query-RunInstances.html
    client.request("RunInstances", params, function (err, resp) {
        if (err) return console.error("RunInstances error: ", JSON.stringify(err));
        
        resp = normalizeResponse(resp);
        var instanceId = resp.instancesSet[0].instanceId;
        params = {
            "ResourceId.1": instanceId,
        };
        var keys = Object.keys(config.instanceTags);
        for (var i = 0; i < keys.length; i++) {
            params["Tag."+(i+1)+".Key"] = keys[i];
            params["Tag."+(i+1)+".Value"] = config.instanceTags[keys[i]];
        };

        if (keys.length > 0) {
            client.request("CreateTags", params, function(err, resp) {
                if (err) return console.error("CreateTags error: ", JSON.stringify(err));

                console.log("Instance " + instanceId + " started in region " + client.region);
            })
        } else {
            console.log("Instance " + instanceId + " started in region " + client.region);
        }
    });
}

function stopInstances(client, instanceIdArray) {
    if (instanceIdArray.length === 0) return; // Nothing to do.
    
    var params = {};
    for (var i = 0; i < instanceIdArray.length; i++)
        params["InstanceId."+(i+1)] = instanceIdArray[i];

    client.request("TerminateInstances", params, function(err, resp) {
        if (err) return console.error("TerminateInstances error: ", JSON.stringify(err));

        console.log("Instances " + instanceIdArray.join(", ") + " terminated in region " + client.region);
    });
}

function getInstances(client, callback) {
    client.request("DescribeInstances", function(err, resp) {
        if (err) return callback(err);
        resp = normalizeResponse(resp);

        var instances = [];
        resp.reservationSet.forEach(function(reservation) {
            reservation.instancesSet.forEach(function(instance) {
                // Check instance is in good state.
                // Possible instance states: pending | running | shutting-down | terminated | stopping | stopped
                var goodStates = ["pending", "running", "shutting-down"];
                if (goodStates.indexOf(instance.instanceState.name) < 0)
                    return;

                // Check instance tags. All tags given in config must be the same.
                if (config.instanceTags) {
                    var tags = {};
                    instance.tagSet.forEach(function(item) {tags[item.key] = item.value;});
                    for (var key in config.instanceTags)
                        if (config.instanceTags[key] !== tags[key])
                            return;
                }

                // All checks successful, add instance to the resulting array.
                instances.push(instance);
            });
        });
        callback(null, instances);
    });
}

function pad(str, width) { while(str.length < width) str=" "+str; return str; }

var status = [], statusRegions = []; // Array of arrays of instances
var updaters = {}; // instance-id -> {lastUpdateTime: .., updateReq: ..., updateRes: {}}
function printStatus() {
    process.stdout.write("\033c"); // Clear screen.
    status.forEach(function(regionInstances, i) {
        console.log(statusRegions[i] + ": ");
        regionInstances.forEach(function(inst) {
            var message = "Unknown";
            var u = updaters[inst.instanceId];
            if (u) {
                var t1 = (u.lastUpdateTime>u.lastReqTime) ? ((u.lastUpdateTime-u.lastReqTime)/100).toFixed(0) : "  ";
                var t2 = ((Date.now()-u.lastReqTime)/100).toFixed(0);
                message = "("+pad(t1, 2)+"/"+pad(t2,2)+") "+JSON.stringify(u.updateRes).replace(/[{}"]/g, "");
                if (u.updateErr) message += " ["+u.updateErr.code+"]";
            }
            console.log("  "+inst.instanceId+"["+inst.instanceState.name+"]: "+message);
            
            if (!u) updaters[inst.instanceId] = u = {lastUpdateTime: Date.now(), lastReqTime: 0, updateRes: {}};
            var rt = Date.now()-u.lastReqTime;
            if (rt > 2000) {
                //if (u.updateReq) {u.updateReq.abort(); delete u.updateReq;}
                if (inst.dnsName != "") {
                    u.lastReqTime = Date.now();
                    var req = http.request({host: inst.dnsName, port: 8889});
                    req.setHeader("Connection", "keep-alive");
                    u.updateReq = req;
                    req.on('response', function(res) {
                        var text = "";
                        res.setEncoding("utf8");
                        res.on('data', function(data) {text = text+data});
                        res.on('end', function() {
                            u.lastUpdateTime = Date.now();
                            u.updateRes = JSON.parse(text);
                            delete u.updateErr;
                            delete u.updateReq;
                        });
                    });
                    req.on('error', function(err) {
                        u.updateErr = err;
                        delete u.updateReq;
                    });
                    req.end();
                }
            }
        });
    });
}

function updateInstances(regions) {
    async.map(regions.map(getClient), getInstances, function(err, res) {
        if (err) return console.error("DescribeInstances error: "+JSON.stringify(err));
        status = res;
        statusRegions = regions;
        updateInstances(regions);
    });
}

function sendParam(client, inst, param, val) {
    if (!inst.dnsName)
        return console.error("Instance "+inst.instanceId+" has no dnsName.");
    var p = {};
    p[param] = val;
    var query = require('querystring').stringify(p);
    var path = (query == 'restart=1') ? '/restart' : ('/set?'+query);
    var req = http.request({host: inst.dnsName, port: config.controlPort, path: path});
    req.on('response', function(res) {
        if (res.statusCode !== 200)
            return console.error("Instance "+inst.instanceId+ " status code = " + res.statusCode);

        var text = "";
        res.setEncoding("utf8");
        res.on('data', function(data) {text += data});
        res.on('end', function() {
            console.log("Instance "+inst.instanceId+ " OK: "+text);
        });
    });
    req.on('error', function(err) {
        console.error("Instance "+inst.instanceId+" error:"+err);
    });
    req.end();
}


// == Process command line arguments ===========================================

program.parse(process.argv);

if (!command_given)
    program.parse(process.argv.slice(0,2).concat(['-h'])); // Print help.
