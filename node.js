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

dotenv.config();

const generateAccessCode = () => crypto.randomBytes(3).toString('hex'); // Generates a 6-character hex string

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

  const key = generateAccessCode();
  const type = req.body.type;
  
  const uploadParams = {
    Bucket: process.env.S3_BUCKET_NAME, // Ensure this is set to your R2 bucket name
    Key: key,
    Body: file.buffer,
    ServerSideEncryption: "AES256",
    ContentType: type,
    Metadata: {
      'filetype': type
    }
  };

  try {
    await s3Client.send(new PutObjectCommand(uploadParams));
    res.json({ message: 'File uploaded successfully', key });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).send(error.message);
  }
});

app.get('/retrieve', async (req, res) => {
  const { accessCode } = req.query;
  if (!accessCode) {
    return res.status(400).send('Access code is required');
  }

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: accessCode,
      ResponseContentDisposition: `attachment; filename="${accessCode}"`
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    res.json({ fileUrl: url });
  } catch (error) {
    console.error('Error retrieving file:', error);
    res.status(500).send('Error retrieving file');
  }
});

app.get('/', async (req, res) => {
  res.status(200).send('Hello');
});

const PORT = process.env.PORT || 5001;

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
