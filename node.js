import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import cors from 'cors';
import crypto from 'crypto';
const generateAccessCode = () => {
    return crypto.randomBytes(3).toString('hex'); // 3 bytes = 6 hexadecimal characters
};
dotenv.config();
import cron from 'node-cron';

const app = express();
app.use(cors());
app.use(express.json());

const s3Client = new S3Client({
  region: process.env.REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload', upload.single('file'), async (req, res) => {

    const file = req.file;
    if (!file) {
        return res.status(400).send('No file uploaded.');
    }

  const key = generateAccessCode();

  let type = req.body.type.split("/")[1];

  let preceed = req.body.type.split("/")[0];

  if(preceed === 'application'){
        type = preceed + '/' + type
  }
  
  const uploadParams = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: `${key}`, // Consider including an access code or unique identifier in the key
    Body: file.buffer,
    ServerSideEncryption: "AES256",
    ContentType: type,
    Metadata: {
        'filetype': req.body.type // Custom metadata for file type
    }
};

  try {
    await s3Client.send(new PutObjectCommand(uploadParams));

    // Here, you would generate an access code and save the mapping between the access code and the file key
    // For demonstration, we'll pretend an access code is generated here
    const accessCode = 'exampleAccessCode'; // Implement your logic for generating and storing access codes

    res.json({ message: 'File uploaded successfully', key });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).send(error.message);
  }
});

// Assuming an endpoint that maps access codes to S3 keys exists,
// you would retrieve the S3 object key using the provided access code
app.get('/retrieve', async (req, res) => {
  const { accessCode } = req.query;
  if (!accessCode) {
    return res.status(400).send('Access code is required');
  }

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: accessCode,
      ResponseContentDisposition: `attachment; filename="${accessCode}"` // Customize the filename as needed
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // Generate a presigned URL

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
  const thirtyMinutesAgo = new Date(Date.now() - 5 * 60000);
  console.log("deleting old objs")
  try {
    const { Contents } = await s3Client.send(new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME,
    }));

    const toDelete = Contents.filter(file => 
      file.LastModified < thirtyMinutesAgo
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
