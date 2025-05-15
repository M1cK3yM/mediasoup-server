import express from "express";
import cors from "cors";
import mediasoup from "mediasoup";
import { networkInterfaces } from "os";
import { Eureka } from "eureka-js-client";

// SSL cert for HTTPS access
const options = {
  // key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
  // cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8')
};

const app = express();
app.use(express.json());
app.use(cors());

let worker;
let ipAddress = process.argv[2];
const port = 3000;

app.get("/info", (_, res) => {
  res.json({ status: "UP", name: "mediasoup-service" });
});

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    console.error("mediasoup worker has died: ", error);
    setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
  });

  return worker;
};

// We create a Worker as soon as our application starts
worker = createWorker();

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

let rooms = {};
let peers = {};
let transports = [];
let producers = [];
let consumers = [];

app.get("/api/stream/joinRoom", async (req, res) => {
  let roomId = req.query.room;
  let userId = req.query.user;

  if (roomId === undefined) {
    for (;;) {
      roomId = Math.random().toString(36).substring(5);
      if (!rooms[roomId]) break;
    }
  }

  if (userId === undefined) {
    for (;;) {
      userId = Math.random().toString(36).substring(5);
      if (!peers[userId]) break;
    }
  }

  let router;
  let p = [];

  if (rooms[roomId]) {
    if (peers[userId]) {
      res.status(403);
      res.send("Room already exists");
      return;
    }
    router = rooms[roomId].router;
    p = rooms[roomId].peers || [];
  } else {
    router = await worker.createRouter({ mediaCodecs });
  }

  rooms[roomId] = {
    router: router,
    peers: [...p, userId],
  };

  peers[userId] = {
    roomId,
    transports: [],
    producers: [],
    consumers: [],
    peerDetails: {
      name: "",
      isAdmin: false,
    },
  };

  const rtpCapabilities = router.rtpCapabilities;
  console.log(JSON.stringify({ roomId, userId, rtpCapabilities }, null, 2));
  res.json({ roomId, userId, rtpCapabilities });
});

app.get("/api/stream/createTransport", async (req, res) => {
  try {
    const isProducer = req.query.consumer || false;
    console.log(isProducer);
    const userId = req.query.user;
    const roomId = peers[userId].roomId;

    if (!roomId && !rooms[roomId]) {
      throw new Error("invalid room id");
    }
    const webRtcTransport_options = {
      listenIps: [
        {
          ip: ipAddress,
          announcedIp: ipAddress,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    };

    console.log(`Router: ${JSON.stringify(rooms[roomId].router)}`);

    let transport = await rooms[roomId].router.createWebRtcTransport(
      webRtcTransport_options,
    );
    console.log(`transport id: ${transport.id}`);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("close", () => {
      console.log("transport closed");
    });

    res.json({
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });

    transports = [
      ...transports,
      { userId, transport, roomId, consumer: isProducer },
    ];

    peers[userId] = {
      ...peers[userId],
      transports: [...peers[userId].transports, transport.id],
    };
    console.log(peers);
    console.log(transports);
    console.log(`Rooms: ${JSON.stringify(transports)}`);
  } catch (error) {
    console.log(error);
    res.json({
      params: {
        error: error,
      },
    });
  }
});

app.post("/api/stream/connectTransport", async (req, res) => {
  const { userId, dtlsParameters } = req.body;
  console.log(userId);
  const producerTransport = transports.filter(
    (transport) => transport.userId == userId && transport.consumer == "false",
  )[0];

  console.log("producer ", producerTransport);
  await producerTransport.transport.connect({ dtlsParameters });

  res.json({
    msg: "success",
  });
});

app.post("/api/stream/produceTransport", async (req, res) => {
  const { userId, kind, rtpParameters, appData } = req.body;

  const { roomId } = peers[userId];

  const [producerTransport] = transports.filter(
    (transport) => transport.userId === userId && transport.consumer == "false",
  );
  const producer = await producerTransport.transport.produce({
    kind,
    rtpParameters,
  });

  console.log("Producer ID: ", producer.id, producer.kind);

  producers = [...producers, { roomId, userId, producer, id: producer.id }];

  peers[userId] = {
    ...peers[userId],
    producers: [...peers[userId].producers, producer.id],
  };

  //TODO: inform users

  producer.on("transportclose", () => {
    console.log("transport for this producer closed ");
    producer.close();
  });

  res.json({
    id: producer.id,
  });
});

app.post("/api/stream/connectRecvTransport", async (req, res) => {
  const { serverId, dtlsParameters } = req.body;
  const consumerTransport = transports.find(
    (transport) =>
      transport.consumer == "true" && transport.transport.id == serverId,
  ).transport;

  await consumerTransport.connect({ dtlsParameters });

  res.json({
    msg: "success",
  });
});

app.post("/api/stream/consume", async (req, res) => {
  const { userId, serverId, remoteProducerId, rtpCapabilities } = req.body;

  try {
    const { roomId } = peers[userId];
    const router = rooms[roomId].router;

    const consumerTransport = transports.find(
      (transport) =>
        transport.consumer == "true" && transport.transport.id == serverId,
    ).transport;

    if (
      router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities,
      })
    ) {
      console.log("consumer transport", consumerTransport);
      const consumer = await consumerTransport.consume({
        producerId: remoteProducerId,
        rtpCapabilities,
        paused: true,
      });

      console.log("consumer", consumer);
      consumer.on("transportclose", () => {
        console.log("transport close from consumer");
      });

      consumer.on("producerclose", () => {
        console.log("producer of consumer closed");
        // TODO: handle when producer closed
      });

      consumers = [...consumers, { userId, consumer, roomId }];

      peers[userId] = {
        ...peers[userId],
        consumers: [...peers[userId].consumers, consumer.id],
      };

      const params = {
        id: consumer.id,
        producerId: remoteProducerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        serverConsumerId: consumer.id,
      };

      console.log("consumer params: ", params);

      res.json({ params });
    }
  } catch (error) {}
});

app.get("/api/stream/getProducers", async (req, res) => {
  const userId = req.query.user;
  const roomId = peers[userId].roomId;

  const [ProducerList] = producers.filter(
    (producer) => producer.roomId == roomId && producer.userId !== userId,
  );
  // producers = [...producers, { roomId, userId, producer }];
  console.log(peers[userId]);
  console.log("producer", ProducerList);
  res.json(ProducerList);
});

app.get("/api/stream/resume", async (req, res) => {
  const consumerId = req.query.serverId;
  const { consumer } = consumers.find(
    (consumer) => consumer.consumer.id === consumerId,
  );

  console.log("consumers: ", consumers);
  console.log("resume ", consumer);
  await consumer.resume();
  res.json({
    msg: "resumed",
  });
});

console.log(`ipAddress: ${ipAddress}`);

function getInterfaceAddress(interfaceName) {
  const interfaces = networkInterfaces();

  if (!interfaces[interfaceName]) {
    return undefined;
  }

  const interfaceDetails = interfaces[interfaceName].find(
    (detail) => detail.family === "IPv4" && !detail.internal,
  );
  return interfaceDetails ? interfaceDetails.address : undefined;
}

if (!ipAddress) {
  ipAddress = getInterfaceAddress("eth0"); // Try eth0 first
  if (!ipAddress) {
    // Fallback to any available non-internal IPv4 address
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const interfaceDetails = interfaces[name].find(
        (detail) => detail.family === "IPv4" && !detail.internal,
      );
      if (interfaceDetails) {
        ipAddress = interfaceDetails.address;
        break;
      }
    }
  }

  if (!ipAddress) {
    console.error(
      "Could not determine IP address. Please provide it as a command-line argument.",
    );
    process.exit(1);
  }
}

console.log(`Using IP Address: ${ipAddress}`);

const eurekaClient = new Eureka({
  instance: {
    app: "mediasoup-service",
    hostName: ipAddress, // Your resolved IP address
    ipAddr: ipAddress,
    statusPageUrl: `http://${ipAddress}:3000/info`,
    port: {
      $: 3000,
      "@enabled": true,
    },
    vipAddress: "mediasoup-service",
    dataCenterInfo: {
      "@class": "com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo",
      name: "MyOwn",
    },
  },
  eureka: {
    host: "10.139.27.89", // Eureka server host
    port: 8761, // Eureka server port
    servicePath: "/eureka/apps/",
  },
});

// Start the Eureka client
eurekaClient.start((error) => {
  if (error) {
    console.error("Eureka registration failed:", error);
  } else {
    console.log("Eureka registration successful!");
  }
});

app.listen(port, () => {
  console.log("Listening on port:", port);
});
