// Needed to load lumens.js. Will switch to full ES6 support in backend
// app soon.
require("babel-register")({
  "presets": ["es2015"]
});
var _ = require('lodash');
var express = require('express');
var proxy = require('express-http-proxy');
var stellarSdk = require('stellar-sdk');
var moment = require('moment');
var logger = require('morgan');
var net = require('net');
var redis = require("redis"),
    redisClient = redis.createClient(process.env.REDIS_URL);
var lumens = require("./common/lumens.js");
var nodes = require("./common/nodes.js");
const Sequelize = require('sequelize');

const postgres = require('./postgres');
// Create schema if doesn't exist
postgres.sequelize.sync();

const NODE_ERROR = -1;
const NODE_TIMEOUT = -2;

var app = express();
app.set('port', (process.env.PORT || 5000));
app.set('json spaces', 2);

app.use(logger('combined'));
if (process.env.DEV) {
  app.use('/', proxy('localhost:3000', {
    filter: function(req, res) {
      return req.path == "/" || req.path.indexOf(".js") >= 0 || req.path.indexOf(".html") >= 0 || req.path.indexOf(".css") >= 0;
    }
  }));
} else {
  app.use(express.static('dist'));
}

app.get('/ledgers/public', function(req, res) {
  var day = moment();
  var response = [];

  var multi = redisClient.multi();

  var days = 30;

  for (var i = 0; i < days; i++) {
    response.push({date: day.format("DD-MM")});
    multi.hmget('ledger_public'+day.format("YYYY-MM-DD"), 'transaction_count', 'operation_count');
    day = day.subtract(1, 'days')
  }

  multi.exec(function (err, redisRes) {
    if (err) {
      res.sendStatus(500);
      console.error(err);
      res.error("Error");
      return;
    }

    for (var i = 0; i < days; i++) {
      response[i].transaction_count = parseInt(redisRes[i][0]);
      response[i].operation_count = parseInt(redisRes[i][1]);
    }

    res.send(response);
  });
});

app.get('/api/lumens', function(req, res) {
  redisClient.get('api_lumens', function(err, data) {
    if (err) {
      console.error(err);
      res.sendStatus(500);
      return;
    }

    data = JSON.parse(data);
    res.send(data);
  });
});

app.get('/api/nodes', function(req, res) {
  // Find last timestamp with minutes % 5 == 0
  var date = moment().utc();
  date = date.subtract(date.minutes() % 5, 'minutes');
  const measurementsCount = 150;

  if (process.env.RANDOM_NODES_MEASUREMENTS) {
    var dates = [];

    for (var i = 0; i < measurementsCount; i++) {
      dates.push(date.format("YYYY-MM-DD HH:mm"));
      date = date.subtract(5, 'minutes')
    }

    // Generate some random data
    var response = {};

    for (var node of nodes) {
      response[node.id] = [];
      for (var i = 0; i < measurementsCount; i++) {
        var status;
        var rand = Math.floor(Math.random() * 2);
        if (Math.floor(Math.random() * 10) < 7) {
          status = 1;
        } else {
          status = NODE_ERROR;
        }

        response[node.id].push({
          date: dates[i],
          status: status
        });
      }
    }

    res.send(response);
    return;
  }

  // We want to return the latest 150 measurements (measurements every 5 minutes so from the last 750-1 minutes).
  // We also want to return `0` value for recently added nodes or nodes with no data for a given timestamp.
  // So first we cross join dates and node names and then left join measurements for given nodes and date.
  var latestMeasurement = date.format("YYYY-MM-DD HH:mm");
  var nodeNames = _(nodes).map(node => `('${node.id}')`).join();
  var query = "select n.node_id as node_id, d.day as date, coalesce(m.status, 0) as status "+
    "from (select generate_series(timestamp '"+latestMeasurement+"', timestamp '"+latestMeasurement+"' - interval '"+(measurementsCount*5-1)+" minute', interval '-5 minute')) d(day) "+
    "cross join (select * from (values "+nodeNames+") as node_names) as n(node_id) "+
    "left join node_measurements m ON n.node_id = m.node_id and m.date = d.day order by d.day desc;"

  postgres.sequelize.query(query, {model: postgres.NodeMeasurement}).then(measurements => {
    var response = {};

    for (let measurement of measurements) {
      let node_id = measurement.get('node_id');
      if (response[node_id] === undefined) {
        response[node_id] = [];
      }
      response[node_id].push({
        date: measurement.get('date'),
        status: measurement.get('status'),
      });
    }

    res.send(response);
  });
});

function updateApiLumens() {
  Promise.all([
    lumens.totalCoins("https://horizon.stellar.org"),
    lumens.availableCoins(),
    lumens.distributionAll(),
    lumens.distributionDirectSignup(),
    lumens.distributionBitcoinProgram(),
    lumens.distributionPartnershipProgram(),
    lumens.distributionBuildChallenge(),
  ]).then(function(data) {
    var response = {
      updatedAt: new Date(),
      totalCoins: data[0],
      availableCoins: data[1],
      distributedCoins: data[2],
      programs: {
        directProgram: data[3],
        bitcoinProgram: data[4],
        partnershipProgram: data[5],
        buildChallenge: data[6]
      }
    };

    redisClient.set("api_lumens", JSON.stringify(response), function(err, data) {
      if (err) {
        console.error(err);
        return;
      }

      console.log("/api/lumens data saved!");
    });
  })
  .catch(function(err) {
    console.error(err);
    res.sendStatus(500);
  });
}

setInterval(updateApiLumens, 10*60*1000);
updateApiLumens();

function checkNode(node) {
  return new Promise((resolve, reject) => {
    let client = new net.Socket();
    let start = moment();
    client.setTimeout(10*1000);
    console.log("checkNode: connecting to: "+node.host)

    client.connect(node.port, node.host, function() {
      client.end();
      resolve({id: node.id, connectedIn: moment().diff(start)});
    });

    client.on('error', () => {
      client.end();
      resolve({id: node.id, connectedIn: NODE_ERROR});
    });

    client.on('timeout', () => {
      client.end();
      resolve({id: node.id, connectedIn: NODE_TIMEOUT});
    });
  });
}

function checkNodes() {
  let date = moment().seconds(0).milliseconds(0);

  // Check uptime every 5 minutes
  if (date.minutes() % 5 != 0) {
    console.log("checkNodes: not time "+date.format("YYYY-MM-DD HH:mm"))
    return;
  }

  Promise.all(_.map(nodes, checkNode))
    .then(results => {
      var instances = [];
      for (let result of results) {
        instances.push({
          node_id: result.id,
          date: date,
          status: result.connectedIn
        })
      }

      return postgres.NodeMeasurement.bulkCreate(instances).then(() => {
        console.log(`Added nodes uptime stats for ${date}!`);
      });
    });
}

setInterval(checkNodes, 60*1000);
checkNodes();

// Stream ledgers - get last paging_token
redisClient.get('paging_token', function(err, pagingToken) {
  if (err) {
    console.error(err);
    return
  }

  if (!pagingToken) {
    pagingToken = 'now';
  }

  var horizon = new stellarSdk.Server('https://horizon.stellar.org');
  horizon.ledgers().cursor(pagingToken).stream({
    onmessage: function(ledger) {
      var date = moment(ledger.closed_at).format("YYYY-MM-DD");
      var key = "ledger_public"+date;

      var multi = redisClient.multi();
      multi.hincrby(key, "transaction_count", ledger.transaction_count);
      multi.hincrby(key, "operation_count", ledger.operation_count);
      // Expire the key after 32 days
      multi.expire(key, 60*60*24*32);
      multi.set("paging_token", ledger.paging_token);
      multi.exec(function (err, res) {
        if (err) {
          console.error(err);
          return;
        }
        console.log("Added Ledger:"+ledger.sequence+" "+ledger.closed_at+" "+res);
      });
    }
  });
});

app.listen(app.get('port'), function() {
  console.log('Listening on port', app.get('port'));
});
