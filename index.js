const express = require("express");
const { Client, RemoteAuth } = require("whatsapp-web.js");
const crypto = require("crypto");
const cors = require("cors");
const qrcode = require("qrcode");
require("dotenv").config();
const { AwsS3Store } = require("wwebjs-aws-s3");
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require("@aws-sdk/client-sqs");
const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());

const clients = {};
const timers = {};
let SESSION_SAVED = false;

const putObjectCommand = PutObjectCommand;
const headObjectCommand = HeadObjectCommand;
const getObjectCommand = GetObjectCommand;
const deleteObjectCommand = DeleteObjectCommand;

const sqs = new SQSClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// AWS S3 client configuration
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  httpOptions: {
    timeout: 600000, // Timeout for large file uploads
  },
});

// Helper function to create AWS S3-based store
const createAwsS3Store = (instanceId) => {
  return new AwsS3Store({
    bucketName: "ws-api-sessions",
    remoteDataPath: `whatsapp-sessions/${instanceId}`, // Directory in S3 for each instance
    s3Client: s3,
    putObjectCommand,
    headObjectCommand,
    getObjectCommand,
    deleteObjectCommand,
  });
};

const extractInstanceId = (fileName) => {
  return fileName.replace("RemoteAuth-", "").replace(".zip", ""); // Extracts instance ID
};
// Function to load saved sessions from S3
const loadSavedSessionsFromS3 = async () => {
  const params = {
    Bucket: "ws-api-sessions",
    Prefix: "whatsapp-sessions/", // Set prefix to filter for session files
  };

  try {
    const { Contents } = await s3.send(new ListObjectsV2Command(params));

    if (!Contents || Contents.length === 0) {
      console.log("No existing sessions found. Create a new session.");
      return;
    }

    for (const item of Contents) {
      // Create a new empty file or handle accordingly
      const instanceI1d = item.Key.split("/").pop(); // Get the instanceId from the filename
      const instanceId = extractInstanceId(instanceI1d);
      console.log(
        `Found saved session for instance ${instanceId}, initializing...`
      );
      initializeWhatsAppClientWithQrCode(instanceId);
      console.log(`Session for instance ${instanceId} reinitialized.`);
    }
  } catch (error) {
    console.error("Failed to load saved sessions from S3:", error);
  }
};

// Function to generate a short alphanumeric instance ID
const generateShortInstanceId = () => {
  return crypto.randomBytes(4).toString("hex"); // Generates an 8-character alphanumeric ID
};

// Function to initialize WhatsApp client and return instanceId with QR code
const initializeWhatsAppClientWithQrCode = (instanceId = null) => {
  return new Promise((resolve, reject) => {
    instanceId = instanceId || generateShortInstanceId(); // Use passed instanceId or generate new one
    let qrCodeGenerated = null;

    const client = new Client({
      authStrategy: new RemoteAuth({
        clientId: instanceId,
        store: createAwsS3Store(instanceId),
        backupSyncIntervalMs: 600000, // Backup every 10 minutes
      }),
      puppeteer: {
        headless: false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });

    // Client event listeners
    client.on("qr", async (qr) => {
      qrCodeGenerated = qr; // Store the QR code
      // Generate a data URL for the QR code
      console.log("Qr code generated.");
      // Start a timer to auto-delete instance if not logged in within 5 minutes
      timers[instanceId] = setTimeout(() => {
        if (!clients[instanceId].profile) {
          console.log(
            `Instance ${instanceId} not logged in after 5 minutes, deleting...`
          );
          client.destroy(); // Terminate the client
          delete clients[instanceId]; // Remove from memory
          delete timers[instanceId]; // Clear the timer
        }
      }, 5 * 60 * 1000); // 5 minutes timeout
    });

    client.on("ready", () => {
     
      console.log(
        `WhatsApp Client for instance ${instanceId} is ready and logged in!`
      );
      clients[instanceId] = { client, profile: null };
      clients[instanceId].profile = instanceId;
      clearTimeout(timers[instanceId]); // Clear the timer if user logs in
    });

    client.on("ready", async () => {
      //poll and send message
      // await client.resetState()
      let hasMessages = true;
      queueUrl = process.env.SQS_URL;

      while (hasMessages && queueUrl) {
        try {
          const params = {
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10, // Max allowed by SQS
            VisibilityTimeout: 30, // Adjust based on SMS sending time
            WaitTimeSeconds: 5, // Use long polling to reduce API calls
          };

          const { Messages } = await sqs.send(
            new ReceiveMessageCommand(params)
          );
          if (Messages && Messages.length > 0) {
            for (const message of Messages) {
              const { phoneNumber, messageBody, senderInstance } = JSON.parse(
                message.Body
              ); // Assuming JSON format

              // if (instanceId === senderInstance) {
              // Send SMS using the custom SMS provider

              const client = clients[instanceId].client;
              const chatId = `${phoneNumber}@c.us`; // Format phone number for WhatsApp
              
              const sms2 = await client.sendMessage(chatId, messageBody);
              console.log(sms2)
              if (sms2) {
                // If SMS sent successfully, delete the message from the queue
                await sqs.send(
                  new DeleteMessageCommand({
                    QueueUrl: queueUrl,
                    ReceiptHandle: message.ReceiptHandle,
                  })
                );
                console.log(
                  `Processed and deleted message with ID: ${message.MessageId}`
                );
              } else {
                console.error(
                  `Failed to send SMS for message ID: ${message.MessageId}`
                );
              }
              // }
            }
          } else {
            hasMessages = false; // Exit loop if no more messages
            console.log("No more messages in the queue. Terminating program.");
            if (SESSION_SAVED) {
              process.exit(0);
            } else {
              console.log("waiting for session to be saved....");
              
              process.exit(0);
            }
          }
        } catch (error) {
          console.error("Error processing messages:", error);
          break;
        }
      }
    });

    client.on("authenticated", () => {
      console.log(
        `Client for instance ${instanceId} authenticated successfully.`
      );
    });

    client.on("remote_session_saved", () => {
      console.log("Session saved to S3, existing process.");
      SESSION_SAVED = true;
      process.exit(0);
    });

    client.on("auth_failure", (msg) => {
      console.error(`Authentication failed for instance ${instanceId}:`, msg);
    });

    client.on("disconnected", (reason) => {
      console.log(
        `Client for instance ${instanceId} disconnected due to:`,
        reason
      );
      client.initialize(); // Optionally reinitialize the client after disconnection
    });

    // Initialize the WhatsApp client
    client.initialize();

    // Check if QR code is generated
    const checkQrCode = setInterval(async () => {
      if (qrCodeGenerated) {
        clearInterval(checkQrCode);
        try {
          const qrImage = await qrcode.toDataURL(qrCodeGenerated); // Convert QR code to base64 image string
          clients[instanceId] = { client, qrCode: qrImage, profile: null }; // Store client and QR code
          resolve({ instanceId, qrCode: qrImage });
        } catch (error) {
          reject(
            `Error generating QR code for instance ${instanceId}: ${error}`
          );
        }
      }
    }, 500); // Check every 500ms for QR code
  });
};

// API to create a new WhatsApp session and return the instanceId and QR code
app.post("/create-instance", async (req, res) => {
  try {
    const { instanceId, qrCode } = await initializeWhatsAppClientWithQrCode(); // Wait for QR code to be generated

    return res.status(200).json({
      status: "success",
      message: "WhatsApp instance created successfully.",
      instanceId,
      qrCode, // Return QR code in the response
    });
  } catch (error) {
    console.error("Error creating instance:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to create WhatsApp instance.",
      error,
    });
  }
});

// API to send a message by instance ID
app.post("/send-message", async (req, res) => {
  const { instanceId, number, message } = req.body;

  if (!clients[instanceId]) {
    return res.status(400).json({
      status: "error",
      message: `Instance with ID ${instanceId} does not exist.`,
    });
  }

  const client = clients[instanceId].client;
  const chatId = `${number}@c.us`; // Format phone number for WhatsApp

  try {
    const smsRes = await client.sendMessage(chatId, message);
    return res.status(200).json({
      status: "success",
      message: `Message sent successfully to ${number} from instance ${instanceId}.`,
      smsRes: smsRes,
    });
  } catch (error) {
    console.error(`Error sending message from instance ${instanceId}:`, error);
    return res.status(500).json({
      status: "error",
      message: "Failed to send message.",
      error: error.message,
    });
  }
});

// API to get the details (profile name) of a WhatsApp session by instance ID
app.get("/get-details/:instanceId", (req, res) => {
  const { instanceId } = req.params;

  if (!clients[instanceId]) {
    return res.status(400).json({
      status: "error",
      message: `Instance with ID ${instanceId} does not exist.`,
    });
  }

  const profile = clients[instanceId].profile;

  if (!profile) {
    return res.status(200).json({
      status: "success",
      message: "Instance is ready, but profile details not yet available.",
    });
  }

  return res.status(200).json({
    status: "success",
    instanceId,
    profile, // Return the WhatsApp profile name
  });
});

// API to get all instances with profile names
app.get("/instances", (req, res) => {
  const instances = Object.entries(clients).map(
    ([instanceId, { profile }]) => ({
      instanceId,
      profile: profile || "Not logged in yet",
    })
  );

  return res.status(200).json({
    status: "success",
    instances,
  });
});

//Health check route
app.get("/health", (req, res) => {
  return res.status(200).json({ status: "UP" });
});
app.get("/", (req, res) => {
  return res.status(200).json({ status: "Server UP" });
});

// API to restart an instance by instance ID
app.post("/restart-instance/:instanceId", (req, res) => {
  const { instanceId } = req.params;

  if (!clients[instanceId]) {
    return res.status(400).json({
      status: "error",
      message: `Instance with ID ${instanceId} does not exist.`,
    });
  }

  clients[instanceId].client.initialize(); // Reinitialize the client
  return res.status(200).json({
    status: "success",
    message: `Instance ${instanceId} restarted successfully.`,
  });
});

// API to terminate (delete) an instance by instance ID
app.delete("/terminate-instance/:instanceId", (req, res) => {
  const { instanceId } = req.params;

  if (!clients[instanceId]) {
    return res.status(400).json({
      status: "error",
      message: `Instance with ID ${instanceId} does not exist.`,
    });
  }

  clients[instanceId].client.destroy(); // Terminate the client
  delete clients[instanceId]; // Remove from memory
  delete timers[instanceId]; // Remove timer

  return res.status(200).json({
    status: "success",
    message: `Instance ${instanceId} terminated successfully.`,
  });
});

// Call this when the server starts
loadSavedSessionsFromS3().catch(console.error);

// Start the Express server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
