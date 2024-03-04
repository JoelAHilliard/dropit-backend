import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import cors from 'cors';
import crypto from 'crypto';
import cron from 'node-cron';
import archiver from 'archiver';
dotenv.config();

const generateAccessCode = () => crypto.randomBytes(16); // Generates a 6-character hex string

const app = express();
app.use(cors());
app.use(express.json());
// Configure the S3Client for Cloudflare R2
const s3Client = new S3Client({
  region: 'auto', // Cloudflare R2 does not require a specific region, but 'auto' works
  endpoint: process.env.CLOUDFLARE_R2_ENDPOINT, // Your Cloudflare R2 endpoint
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID, // Your Cloudflare R2 access key
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY, // Your Cloudflare R2 secret key
  },
  forcePathStyle: true, // Important for compatibility with Cloudflare R2
});

const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).send('No file uploaded.');
  }

  // Generate a random IV
  const iv = crypto.randomBytes(16); // 16 bytes for AES-256-CBC

  // Convert IV to hexadecimal string
  const ivHex = iv.toString('hex');
  
  const encryptionKeyBase64 = process.env.ENC_KEY; // Assuming the key is stored in base64
  
  const encryptionKey = Buffer.from(encryptionKeyBase64, 'base64'); // Convert from base64 to binary

  if (encryptionKey.length !== 32) {
    throw new Error('Encryption key must be 32 bytes long.');
  }

  const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
  // Encrypt the file content
  let encryptedData = cipher.update(file.buffer);
  encryptedData = Buffer.concat([encryptedData, cipher.final()]);

  const type = req.body.type;

  const uploadParams = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: ivHex.slice(0,6), // Use IV as the key here
    Body: encryptedData,
    ServerSideEncryption: "AES256",
    ContentType: 'application/zip',
    Metadata: {
      'filetype': type,
      'iv': ivHex,
      'extension': file.originalname.split('.').pop() // Store file extension
    }
  };
  

  try {
    await s3Client.send(new PutObjectCommand(uploadParams));
    res.json({ message: 'File uploaded successfully', key: ivHex.substring(0,6) });
  } catch (error) {
    console.error('Error uploading encrypted file:', error);
    res.status(500).send(error.message);
  }
});

app.get('/retrieve', async (req, res) => {
  const { accessCode } = req.query; // `accessCode` is the IV in hex
  if (!accessCode) {
    return res.status(400).send('Access code is required');
  }

  const encryptionKeyBase64 = process.env.ENC_KEY;
  
  const encryptionKey = Buffer.from(encryptionKeyBase64, 'base64');
  
  if (encryptionKey.length !== 32) {
    return res.status(500).send('Server error: Invalid encryption key');
  }

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: accessCode,
    });

    const { Body, ContentType, Metadata } = await s3Client.send(command);
    const iv = Buffer.from(Metadata.iv, 'hex'); // Convert hex back to binary

    const streamToBuffer = async (stream) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });

    const encryptedData = await streamToBuffer(Body);

    const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey, iv);
    let decryptedData = decipher.update(encryptedData);

    decryptedData = Buffer.concat([decryptedData, decipher.final()]);
    let fileName = `file.${Metadata.extension || 'bin'}`;
    const encodedFileName = encodeURIComponent(fileName);

    console.log(fileName);
    // For simplicity, sending decrypted data as a download

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Type': Metadata.extension,
      'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`,
    });
    
    res.end(decryptedData);
  } catch (error) {
    console.error('Error retrieving and decrypting file:', error);
    res.status(500).send('Error retrieving file');
  }
});


app.get('/', async (req, res) => {
  res.status(200).send('Hello');
});

const PORT = 4000;

async function deleteOldFiles() {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60000);
  try {
    const { Contents } = await s3Client.send(new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME,
    }));

    const toDelete = Contents.filter(file => 
      new Date(file.LastModified) < thirtyMinutesAgo
    ).map(file => ({ Key: file.Key }));

    if (toDelete.length > 0) {
      await s3Client.send(new DeleteObjectsCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Delete: {
          Objects: toDelete,
          Quiet: false
        }
      }));
      console.log(`Deleted ${toDelete.length} old files.`);
    } else {
      console.log("No old files to delete.");
    }
  } catch (error) {
    console.error("Error in deleting old files:", error);
  }
}

cron.schedule('*/30 * * * *', deleteOldFiles);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});
